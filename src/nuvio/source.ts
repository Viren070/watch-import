import type {
  NextUpEntry,
  PullItem,
  WatchlistEntry,
} from '@aiostreams/addon-sdk';
import type { NuvioConfig } from '../config.js';
import type { Source } from '../reads.js';
import {
  rpc,
  type LibraryRow,
  type ProgressRow,
  type WatchedRow,
} from './api.js';
import { accessToken } from './sessions.js';

const MIN_RESUME_MS = 1000;
const LIBRARY_PAGE = 500;
const WATCHED_PAGE = 5000;
/** Nuvio counts a play this long and this far in as watched. */
const PLAYED_MIN_MS = 60_000;
const PLAYED_SHARE = 0.9;

const seconds = (ms: number) => Math.floor(ms / 1000);

function videoIdOf(row: WatchedRow): string | null {
  if (row.episode === null) return null;
  return row.season === null
    ? `${row.content_id}:${row.episode}`
    : `${row.content_id}:${row.season}:${row.episode}`;
}

async function pages<T>(read: (page: number) => Promise<T[]>, size: number) {
  const rows: T[] = [];
  for (let page = 0; ; page++) {
    const batch = await read(page);
    rows.push(...batch);
    if (batch.length < size) return rows;
  }
}

function itemsOf(progress: ProgressRow[]): PullItem[] {
  return progress
    .filter((row) => row.position >= MIN_RESUME_MS)
    .sort((a, b) => b.last_watched - a.last_watched)
    .map((row) => ({
      type: row.content_type,
      metaId: row.content_id,
      videoId: row.video_id,
      season: row.season,
      episode: row.episode,
      positionMs: row.position,
      durationMs: row.duration > 0 ? row.duration : undefined,
      played:
        row.duration >= PLAYED_MIN_MS &&
        row.position >= row.duration * PLAYED_SHARE,
      at: seconds(row.last_watched),
    }));
}

/** The latest episode watched in each show; AIOStreams works out what comes next. */
function nextUpOf(watched: WatchedRow[]): NextUpEntry[] {
  const latest = new Map<string, WatchedRow>();
  for (const row of watched) {
    if (row.content_type === 'movie' || row.episode === null) continue;
    const seen = latest.get(row.content_id);
    if (!seen || row.watched_at > seen.watched_at)
      latest.set(row.content_id, row);
  }
  return [...latest.values()].map((row) => ({
    type: row.content_type,
    metaId: row.content_id,
    videoId: videoIdOf(row)!,
    season: row.season,
    episode: row.episode,
    at: seconds(row.watched_at),
  }));
}

function watchlistOf(library: LibraryRow[]): WatchlistEntry[] {
  return library
    .map((row) => ({
      type: row.content_type,
      kind:
        row.content_type === 'movie' ? ('movie' as const) : ('series' as const),
      metaId: row.content_id,
      at: seconds(row.added_at),
    }))
    .sort((a, b) => (a.metaId < b.metaId ? -1 : 1));
}

export function nuvioSource(config: NuvioConfig): Source {
  const profile = { p_profile_id: config.profile };
  const token = () => accessToken(config.session, config.key);
  return {
    key: `nuvio:${config.session}:${config.profile}|${config.library ? 'l' : ''}`,
    async fingerprint() {
      const access = await token();
      const cursors = await Promise.all([
        rpc<number>(access, 'sync_get_watch_progress_delta_cursor', profile),
        rpc<number>(access, 'sync_get_watched_items_delta_cursor', profile),
        config.library
          ? rpc<number>(access, 'sync_get_library_delta_cursor', profile)
          : 0,
      ]);
      return cursors.join('.');
    },
    async read() {
      const access = await token();
      const [progress, watched, library] = await Promise.all([
        rpc<ProgressRow[]>(access, 'sync_pull_watch_progress', profile),
        pages(
          (page) =>
            rpc<WatchedRow[]>(access, 'sync_pull_watched_items', {
              ...profile,
              p_page: page + 1,
              p_page_size: WATCHED_PAGE,
            }),
          WATCHED_PAGE
        ),
        config.library
          ? pages(
              (page) =>
                rpc<LibraryRow[]>(access, 'sync_pull_library', {
                  ...profile,
                  p_limit: LIBRARY_PAGE,
                  p_offset: page * LIBRARY_PAGE,
                }),
              LIBRARY_PAGE
            )
          : undefined,
      ]);
      const movies = new Set<string>();
      const episodes = new Set<string>();
      for (const row of watched) {
        if (row.content_type === 'movie') movies.add(row.content_id);
        else {
          const videoId = videoIdOf(row);
          if (videoId) episodes.add(videoId);
        }
      }
      return {
        items: itemsOf(progress),
        watched: {
          movies: [...movies].sort(),
          episodes: [...episodes].sort(),
          nextUp: nextUpOf(watched),
        },
        watchlist: library && watchlistOf(library),
      };
    },
  };
}
