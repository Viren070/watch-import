import { createLogger } from '@aiostreams/addon-sdk';
import { accountKey } from '../config.js';
import { UnreachableError, readJson, UpstreamError } from '../http.js';
import { addonCollection, type AddonDescriptor } from './api.js';

const logger = createLogger('meta');

export interface Video {
  id: string;
  season: number | null;
  episode: number | null;
  released: number | null;
}

export interface Meta {
  id: string;
  videos: Video[];
}

/** Every source answered and none of them knows the title. */
export class MetaNotFound extends Error {}

interface Source {
  base: string;
  types: string[];
  idPrefixes: string[] | null;
}

const FALLBACK_SOURCES: Source[] = [
  {
    base: 'https://v3-cinemeta.strem.io',
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
  },
  {
    base: 'https://anime-kitsu.strem.fun',
    types: ['anime', 'movie', 'series'],
    idPrefixes: ['kitsu:'],
  },
];

const SOURCES_TTL_MS = 60 * 60_000;
const SOURCES_RETRY_MS = 5 * 60_000;
const FOUND_TTL_MS = 6 * 60 * 60_000;
const MISSING_TTL_MS = 60 * 60_000;
const MAX_CACHED = 5000;
const MAX_CONCURRENT = 32;
/** So one account's cold library cannot take every slot. */
const MAX_CONCURRENT_PER_ACCOUNT = 4;
const FAILURES_BEFORE_SKIP = 5;
const SKIP_MS = 2 * 60_000;
const REFUSED_SKIP_MS = 60 * 60_000;

function baseOf(transportUrl: string): string {
  return transportUrl.replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
}

function sourcesOf(addons: AddonDescriptor[]): Source[] {
  const sources: Source[] = [];
  for (const addon of addons) {
    if (typeof addon?.transportUrl !== 'string') continue;
    const manifest = addon.manifest ?? {};
    for (const resource of manifest.resources ?? []) {
      const name = typeof resource === 'string' ? resource : resource?.name;
      if (name !== 'meta') continue;
      const own = typeof resource === 'string' ? undefined : resource;
      sources.push({
        base: baseOf(addon.transportUrl),
        types: own?.types ?? manifest.types ?? [],
        idPrefixes: own?.idPrefixes ?? manifest.idPrefixes ?? null,
      });
      break;
    }
  }
  for (const fallback of FALLBACK_SOURCES) {
    if (!sources.some((s) => s.base === fallback.base)) sources.push(fallback);
  }
  return sources;
}

const sourceCache = new Map<
  string,
  { sources: Promise<Source[]>; expires: number }
>();

function sourcesFor(authKey: string): Promise<Source[]> {
  const key = accountKey(authKey);
  const cached = sourceCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.sources;

  const sources = addonCollection(authKey)
    .then(sourcesOf)
    .catch((error) => {
      if (!(error instanceof UpstreamError)) {
        sourceCache.delete(key);
        throw error;
      }
      logger.warn({ err: error }, 'addon collection unreadable');
      sourceCache.set(key, {
        sources: Promise.resolve(FALLBACK_SOURCES),
        expires: Date.now() + SOURCES_RETRY_MS,
      });
      return FALLBACK_SOURCES;
    });
  sourceCache.set(key, { sources, expires: Date.now() + SOURCES_TTL_MS });
  return sources;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sourceCache) {
    if (entry.expires <= now) sourceCache.delete(key);
  }
  for (const [host, health] of hosts) {
    if (health.downUntil <= now && health.failures === 0) hosts.delete(host);
  }
}, 10 * 60_000).unref();

function supports(source: Source, type: string, id: string): boolean {
  return (
    source.types.includes(type) &&
    (!source.idPrefixes || source.idPrefixes.some((p) => id.startsWith(p)))
  );
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function toVideo(raw: unknown): Video | null {
  if (!raw || typeof raw !== 'object') return null;
  const video = raw as Record<string, unknown>;
  if (typeof video.id !== 'string' || !video.id) return null;
  const season = wholeNumber(video.season);
  const episode = wholeNumber(video.episode);
  const released =
    typeof video.released === 'string' ? Date.parse(video.released) : NaN;
  const paired = season !== null && episode !== null;
  return {
    id: video.id,
    season: paired ? season : null,
    episode: paired ? episode : null,
    released: Number.isFinite(released) ? released : null,
  };
}

const bitfieldIds = new WeakMap<Meta, string[]>();

/** The order the watched bitfield's bits follow, which is not the display order. */
export function bitfieldOrder(meta: Meta): string[] {
  let ids = bitfieldIds.get(meta);
  if (!ids) {
    const key = (n: number | null) => n ?? Number.NEGATIVE_INFINITY;
    ids = [...meta.videos]
      .sort(
        (a, b) =>
          key(a.season) - key(b.season) ||
          key(a.episode) - key(b.episode) ||
          key(a.released) - key(b.released) ||
          0
      )
      .map((v) => v.id);
    bitfieldIds.set(meta, ids);
  }
  return ids;
}

function toMeta(raw: unknown): Meta | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw as Record<string, unknown>;
  if (typeof meta.id !== 'string' || typeof meta.type !== 'string') return null;
  const seen = new Set<string>();
  const videos: Video[] = [];
  for (const entry of Array.isArray(meta.videos) ? meta.videos : []) {
    const video = toVideo(entry);
    if (!video || seen.has(video.id)) continue;
    seen.add(video.id);
    videos.push(video);
  }
  return { id: meta.id, videos };
}

const metaCache = new Map<string, { meta: Meta | null; expires: number }>();
const inFlight = new Map<string, Promise<Meta | null>>();

class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot passes straight to the next waiter.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const shared = new Limiter(MAX_CONCURRENT);
const perAccount = new Map<string, Limiter>();

async function limited<T>(account: string, task: () => Promise<T>) {
  let own = perAccount.get(account);
  if (!own) {
    own = new Limiter(MAX_CONCURRENT_PER_ACCOUNT);
    perAccount.set(account, own);
  }
  try {
    return await own.run(() => shared.run(task));
  } finally {
    if (own.idle) perAccount.delete(account);
  }
}

/** A host that keeps failing is skipped for a while, so a dead addon costs a few timeouts, not one per title. */
const hosts = new Map<
  string,
  { failures: number; downUntil: number; refused: boolean }
>();

function skipped(host: string): 'refused' | 'down' | null {
  const health = hosts.get(host);
  if (!health || health.downUntil <= Date.now()) return null;
  return health.refused ? 'refused' : 'down';
}

function downError(host: string): never {
  throw new UpstreamError(`${host}: skipped after repeated failures`);
}

function noteFailure(host: string, refused: boolean): void {
  if (refused) {
    hosts.set(host, {
      failures: 0,
      downUntil: Date.now() + REFUSED_SKIP_MS,
      refused,
    });
    return;
  }
  const health = hosts.get(host) ?? {
    failures: 0,
    downUntil: 0,
    refused: false,
  };
  health.failures++;
  if (health.failures >= FAILURES_BEFORE_SKIP) {
    health.failures = 0;
    health.downUntil = Date.now() + SKIP_MS;
  }
  hosts.set(host, health);
}

function remember(key: string, meta: Meta | null): void {
  metaCache.delete(key);
  metaCache.set(key, {
    meta,
    expires: Date.now() + (meta ? FOUND_TTL_MS : MISSING_TTL_MS),
  });
  if (metaCache.size > MAX_CACHED) {
    metaCache.delete(metaCache.keys().next().value!);
  }
}

/**
 * Null when the addon does not know the title or may not be reached; throws
 * when it could not be asked right now.
 */
async function fetchMeta(
  account: string,
  source: Source,
  type: string,
  id: string
): Promise<Meta | null> {
  const key = `${source.base}|${type}|${id}`;
  const cached = metaCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.meta;

  const host = new URL(source.base).host;
  if (skipped(host))
    return skipped(host) === 'refused' ? null : downError(host);

  let pending = inFlight.get(key);
  if (!pending) {
    pending = limited(account, async () => {
      // Checked again, for requests that queued before the host was written off.
      const skip = skipped(host);
      if (skip) return skip === 'refused' ? null : downError(host);
      const url = `${source.base}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      try {
        const { status, json } = await readJson(url, {
          headers: { accept: 'application/json' },
          timeoutMs: 10_000,
          maxBytes: 8 * 1024 * 1024,
          untrusted: true,
        });
        hosts.delete(host);
        const meta =
          status < 400
            ? toMeta((json as { meta?: unknown } | null)?.meta)
            : null;
        remember(key, meta);
        return meta;
      } catch (error) {
        // A miss here counts as "no episodes", so the fallbacks are never written off.
        if (
          error instanceof UnreachableError &&
          !FALLBACK_SOURCES.includes(source)
        ) {
          noteFailure(host, true);
          return null;
        }
        if (error instanceof UpstreamError || error instanceof UnreachableError)
          noteFailure(host, false);
        throw error instanceof UnreachableError
          ? new UpstreamError(error.message)
          : error;
      }
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** The first answer in collection order wins, as on Stremio's meta page. */
export async function resolveMeta(
  authKey: string,
  type: string,
  id: string
): Promise<Meta> {
  const account = accountKey(authKey);
  const sources = (await sourcesFor(authKey)).filter((s) =>
    supports(s, type, id)
  );
  let failure: Error | null = null;
  for (const source of sources) {
    try {
      const meta = await fetchMeta(account, source, type, id);
      if (meta) return meta;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (failure) throw new UpstreamError(`meta for ${id}: ${failure.message}`);
  throw new MetaNotFound(`no addon has meta for ${type} ${id}`);
}
