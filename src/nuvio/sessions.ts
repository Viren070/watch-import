import { createLogger } from '@aiostreams/addon-sdk';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
import { NuvioAuthError, refresh, type Tokens } from './api.js';

const logger = createLogger('nuvio');

const DIR = join(env.DATA_DIR, 'nuvio-sessions');
/** Used well before it expires, so a slow request never carries an expired token. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
const IDLE_MS = 24 * 60 * 60_000;
/** A session in use is renewed, and rewritten, at least weekly, so only an unused file ages this far. */
const UNUSED_DAYS = 90;

interface Stored {
  refreshToken: string;
  userId: string;
}

interface Held extends Stored {
  key: Buffer;
  accessToken?: string;
  expiresAt: number;
  usedAt: number;
  renewing?: Promise<string>;
}

const held = new Map<string, Held>();
const loading = new Map<string, Promise<Held>>();

const fileOf = (id: string) => join(DIR, `${id}.json`);

function seal(key: Buffer, stored: Stored): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(stored), 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  });
}

function open(key: Buffer, text: string): Stored {
  const { iv, tag, data } = JSON.parse(text);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  );
}

async function save(id: string, key: Buffer, stored: Stored): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const temporary = `${fileOf(id)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, seal(key, stored), { mode: 0o600 });
  await rename(temporary, fileOf(id));
}

function keep(id: string, key: Buffer, stored: Stored, tokens?: Tokens): Held {
  const entry: Held = {
    ...stored,
    key,
    accessToken: tokens?.access_token,
    expiresAt: tokens ? Date.now() + tokens.expires_in * 1000 : 0,
    usedAt: Date.now(),
  };
  held.set(id, entry);
  return entry;
}

/** Takes the browser's refresh token and swaps it for one only this server holds. */
export async function createSession(
  refreshToken: string
): Promise<{ id: string; key: string; accessToken: string }> {
  const tokens = await refresh(refreshToken);
  const id = randomBytes(16).toString('base64url');
  const key = randomBytes(32);
  const stored = { refreshToken: tokens.refresh_token, userId: tokens.user.id };
  await save(id, key, stored);
  keep(id, key, stored, tokens);
  return {
    id,
    key: key.toString('base64url'),
    accessToken: tokens.access_token,
  };
}

async function load(id: string, key: Buffer): Promise<Held> {
  let entry = held.get(id);
  if (!entry) {
    let pending = loading.get(id);
    if (!pending) {
      pending = readFile(fileOf(id), 'utf8')
        .then((text) => keep(id, key, open(key, text)))
        .catch(() => {
          throw new NuvioAuthError('Unknown Nuvio session');
        })
        .finally(() => loading.delete(id));
      loading.set(id, pending);
    }
    entry = await pending;
  }
  if (entry.key.length !== key.length || !timingSafeEqual(entry.key, key)) {
    throw new NuvioAuthError('Unknown Nuvio session');
  }
  return entry;
}

async function renew(id: string, entry: Held): Promise<string> {
  let tokens: Tokens;
  try {
    tokens = await refresh(entry.refreshToken);
  } catch (error) {
    if (error instanceof NuvioAuthError) {
      held.delete(id);
      await rm(fileOf(id), { force: true });
    }
    throw error;
  }
  entry.refreshToken = tokens.refresh_token;
  entry.accessToken = tokens.access_token;
  entry.expiresAt = Date.now() + tokens.expires_in * 1000;
  await save(id, entry.key, {
    refreshToken: entry.refreshToken,
    userId: entry.userId,
  }).catch((err) => logger.error({ err }, 'could not store a renewed session'));
  return entry.accessToken;
}

export async function accessToken(id: string, key: string): Promise<string> {
  const entry = await load(id, Buffer.from(key, 'base64url'));
  entry.usedAt = Date.now();
  if (entry.accessToken && entry.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return entry.accessToken;
  }
  entry.renewing ??= renew(id, entry).finally(() => {
    entry.renewing = undefined;
  });
  return entry.renewing;
}

async function prune(): Promise<void> {
  const now = Date.now();
  for (const [id, entry] of held) {
    if (entry.usedAt < now - IDLE_MS && !entry.renewing) held.delete(id);
  }
  const names = await readdir(DIR).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(DIR, name);
    const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: now }));
    if (mtimeMs < now - UNUSED_DAYS * 24 * 60 * 60_000) {
      await rm(path, { force: true });
    }
  }
}

setInterval(() => {
  prune().catch((err) => logger.warn({ err }, 'pruning sessions failed'));
}, 60 * 60_000).unref();
