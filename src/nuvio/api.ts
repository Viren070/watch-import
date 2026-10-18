import { readJson } from '../http.js';

const API = 'https://api.nuvio.tv';
/** Nuvio publishes this key for third-party clients. */
const PUBLISHABLE_KEY = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN';

export class NuvioAuthError extends Error {}

/** Nuvio understood the request and refused it. */
export class NuvioError extends Error {}

async function call<T>(
  path: string,
  body: object,
  accessToken?: string
): Promise<T> {
  const { status, json } = await readJson(`${API}${path}`, {
    method: 'POST',
    headers: {
      apikey: PUBLISHABLE_KEY,
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
    maxBytes: 64 * 1024 * 1024,
  });
  if (status < 400) return json as T;
  const detail = json as { message?: string; msg?: string } | null;
  const message = `Nuvio ${path}: ${detail?.message ?? detail?.msg ?? `HTTP ${status}`}`;
  if (status === 401) throw new NuvioAuthError(message);
  throw new NuvioError(message);
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string };
}

/** The answer carries the refresh token to use next time. */
export async function refresh(refreshToken: string): Promise<Tokens> {
  try {
    return await call<Tokens>('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    });
  } catch (error) {
    if (error instanceof NuvioError) throw new NuvioAuthError(error.message);
    throw error;
  }
}

export function rpc<T>(
  accessToken: string,
  name: string,
  args: object
): Promise<T> {
  return call<T>(`/rest/v1/rpc/${name}`, args, accessToken);
}

export interface Profile {
  profile_index: number;
  name: string;
}

export interface ProgressRow {
  content_id: string;
  content_type: string;
  video_id: string;
  season: number | null;
  episode: number | null;
  position: number;
  duration: number;
  last_watched: number;
}

export interface WatchedRow {
  content_id: string;
  content_type: string;
  season: number | null;
  episode: number | null;
  watched_at: number;
}

export interface LibraryRow {
  content_id: string;
  content_type: string;
  added_at: number;
}
