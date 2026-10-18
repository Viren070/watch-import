import { createHash } from 'node:crypto';
import {
  createLogger,
  type PullItem,
  type Watched,
  type WatchlistEntry,
} from '@aiostreams/addon-sdk';

const logger = createLogger('reads');

/** A service is asked whether anything changed at most this often per account, whoever calls. */
const RECHECK_MS = 10_000;
const KEEP_FULL_ANSWER_MS = 60_000;
const IDLE_MS = 24 * 60 * 60_000;
const MAX_SNAPSHOTS = 50_000;

export interface Read {
  items: PullItem[];
  /** Left out when part of it could not be read in time. */
  watched?: Watched;
  watchlist?: WatchlistEntry[];
}

export interface Source {
  /** Accounts with the same key share one snapshot. */
  key: string;
  /** Changes whenever anything `read` returns does. */
  fingerprint(): Promise<string>;
  read(deadline: number): Promise<Read>;
}

export interface PullAnswer extends Read {
  version?: string;
}

export interface PullResult {
  answer: PullAnswer;
  complete: boolean;
}

interface Snapshot {
  fingerprint: string;
  checkedAt: number;
  usedAt: number;
  /** Only once a read was complete. */
  version?: string;
  items: PullItem[];
  /** The last full answer, dropped once it expires. */
  last?: PullResult;
  lastUntil: number;
}

const snapshots = new Map<string, Snapshot>();
const queues = new Map<string, Promise<unknown>>();

setInterval(() => {
  const now = Date.now();
  for (const [key, snapshot] of snapshots) {
    if (snapshot.usedAt < now - IDLE_MS) snapshots.delete(key);
    else if (snapshot.lastUntil < now) snapshot.last = undefined;
  }
}, 60_000).unref();

/** Covers the watchlist too, so it can be left out with `watched`. */
function versionOf(watched: Watched, watchlist?: WatchlistEntry[]): string {
  const hash = createHash('sha256');
  for (const id of watched.movies ?? []) hash.update(`m${id}\n`);
  for (const id of watched.episodes ?? []) hash.update(`e${id}\n`);
  for (const n of watched.nextUp ?? []) hash.update(`n${n.videoId}|${n.at}\n`);
  for (const w of watchlist ?? []) hash.update(`w${w.metaId}|${w.at}\n`);
  return hash.digest('hex').slice(0, 16);
}

function remember(key: string, snapshot: Snapshot): void {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  if (snapshots.size > MAX_SNAPSHOTS) {
    snapshots.delete(snapshots.keys().next().value!);
  }
}

function gated(snapshot: Snapshot): PullResult {
  return {
    answer: { version: snapshot.version, items: snapshot.items },
    complete: true,
  };
}

async function read(
  source: Source,
  since: string | undefined,
  budgetMs: number
): Promise<PullResult> {
  const now = Date.now();
  const held = snapshots.get(source.key);

  const recent = held && now - held.checkedAt < RECHECK_MS;
  const fingerprint = recent ? held.fingerprint : await source.fingerprint();
  if (held?.fingerprint === fingerprint) {
    held.usedAt = now;
    if (!recent) held.checkedAt = now;
    if (held.version && since === held.version) return gated(held);
    if (held.last && (recent || now < held.lastUntil)) return held.last;
  }

  const { items, watched, watchlist } = await source.read(now + budgetMs);
  const complete = watched !== undefined;
  const result: PullResult = { answer: { items }, complete };
  if (watched) {
    result.answer = {
      version: versionOf(watched, watchlist),
      items,
      watched,
      ...(watchlist ? { watchlist } : {}),
    };
  } else {
    logger.info(
      { source: source.key.split(':')[0] },
      'answering without the watched history until a read completes'
    );
  }

  const snapshot: Snapshot = {
    fingerprint,
    checkedAt: now,
    usedAt: now,
    version: result.answer.version,
    items,
    last: result,
    lastUntil: now + (complete ? KEEP_FULL_ANSWER_MS : RECHECK_MS),
  };
  remember(source.key, snapshot);
  return snapshot.version && since === snapshot.version
    ? gated(snapshot)
    : result;
}

/** One read at a time per account, so the ones behind it answer from its snapshot. */
export function buildPull(
  source: Source,
  since: string | undefined,
  budgetMs: number
): Promise<PullResult> {
  const run = (queues.get(source.key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => read(source, since, budgetMs));
  queues.set(source.key, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      if (queues.get(source.key) === run) queues.delete(source.key);
    });
  return run;
}
