import { createHash } from 'node:crypto';
import {
  createLogger,
  type NextUpEntry,
  type PullItem,
  type WatchlistEntry,
} from '@aiostreams/addon-sdk';
import { accountKey, type StremioConfig } from '../config.js';
import { UpstreamError } from '../http.js';
import { splitVideoId } from '../ids.js';
import type { Source } from '../reads.js';
import { libraryMeta } from './api.js';
import { readLibrary } from './library.js';
import {
  isInContinueWatching,
  isTrackable,
  timeOf,
  type LibraryItem,
} from './library-item.js';
import { bitfieldOrder, MetaNotFound, resolveMeta } from './meta.js';
import { WatchedBitField } from './watched.js';

const logger = createLogger('stremio');

/** Shorter offsets are Stremio's next-episode marker (1 ms) or a start that never got going. */
const MIN_RESUME_MS = 1000;
const MAX_ITEMS = 500;

const seconds = (ms: number) => Math.floor(ms / 1000);

const isMovie = (item: LibraryItem) => item.type === 'movie';

function fingerprintOf(meta: [string, number][]): string {
  const hash = createHash('sha256');
  for (const [id, mtime] of [...meta].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  )) {
    hash.update(`${id}\0${mtime}\n`);
  }
  return hash.digest('hex');
}

/** Null when the show could not be read right now. */
async function watchedEpisodes(
  authKey: string,
  item: LibraryItem
): Promise<string[] | null> {
  try {
    const meta = await resolveMeta(authKey, item.type, item._id);
    return WatchedBitField.decode(
      item.state.watched,
      bitfieldOrder(meta)
    ).watchedIds();
  } catch (error) {
    // Stremio cannot show these episodes either.
    if (error instanceof MetaNotFound) return [];
    if (error instanceof UpstreamError) return null;
    throw error;
  }
}

/**
 * Shows are decoded against their meta, which is slow cold, so whatever is
 * unfinished at the deadline keeps warming the cache for the next read.
 */
async function decodeShows(
  authKey: string,
  shows: LibraryItem[],
  deadline: number
): Promise<Map<string, string[] | null>> {
  const episodesOf = new Map<string, string[] | null>();
  const decoding = Promise.all(
    shows.map((item) =>
      watchedEpisodes(authKey, item).then((ids) => {
        episodesOf.set(item._id, ids);
      })
    )
  );
  decoding.catch((error) =>
    logger.warn({ err: error }, 'decoding watched episodes failed')
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    decoding,
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    }),
  ]);
  clearTimeout(timer);
  return episodesOf;
}

function inProgress(
  library: LibraryItem[],
  episodesOf: Map<string, string[] | null>
): PullItem[] {
  const items: PullItem[] = [];
  const candidates = library
    .filter(
      (item) =>
        isInContinueWatching(item) && item.state.timeOffset >= MIN_RESUME_MS
    )
    .sort((a, b) => timeOf(b.state.lastWatched) - timeOf(a.state.lastWatched));
  for (const item of candidates) {
    const videoId = isMovie(item) ? item._id : item.state.video_id;
    if (!videoId) continue;
    const split = isMovie(item)
      ? { season: null, episode: null }
      : splitVideoId(videoId);
    if (!isMovie(item) && split.episode === null) continue;
    items.push({
      type: item.type,
      metaId: item._id,
      videoId,
      season: split.season,
      episode: split.episode,
      positionMs: item.state.timeOffset,
      durationMs: item.state.duration || undefined,
      played: isMovie(item)
        ? item.state.timesWatched > 0
        : (episodesOf.get(item._id)?.includes(videoId) ?? false),
      at: seconds(timeOf(item.state.lastWatched)),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function nextUpOf(
  shows: LibraryItem[],
  episodesOf: Map<string, string[] | null>
): NextUpEntry[] {
  return shows
    .filter(
      (item) => item.state.video_id && episodesOf.get(item._id)!.length > 0
    )
    .map((item) => {
      const videoId = item.state.video_id!;
      const { season, episode } = splitVideoId(videoId);
      return {
        type: item.type,
        metaId: item._id,
        videoId,
        season,
        episode,
        at: seconds(timeOf(item.state.lastWatched)),
      };
    });
}

function watchlistOf(library: LibraryItem[]): WatchlistEntry[] {
  return library
    .filter((item) => !item.removed)
    .map((item) => ({
      type: item.type,
      kind: isMovie(item) ? ('movie' as const) : ('series' as const),
      metaId: item._id,
      at: seconds(timeOf(item._ctime) || timeOf(item._mtime)),
    }))
    .sort((a, b) => (a.metaId < b.metaId ? -1 : 1));
}

export function stremioSource(config: StremioConfig): Source {
  const { authKey } = config;
  return {
    key: `stremio:${accountKey(authKey)}|${config.library ? 'l' : ''}`,
    fingerprint: async () => fingerprintOf(await libraryMeta(authKey)),
    async read(deadline) {
      const library = (await readLibrary(authKey)).filter(isTrackable);
      const shows = library
        .filter((item) => !isMovie(item) && item.state.watched)
        .sort((a, b) => (a._id < b._id ? -1 : 1));
      const episodesOf = await decodeShows(authKey, shows, deadline);
      const items = inProgress(library, episodesOf);
      const complete =
        episodesOf.size === shows.length &&
        [...episodesOf.values()].every((ids) => ids !== null);
      if (!complete) {
        logger.debug(
          { shows: shows.length, read: episodesOf.size },
          'some shows are still being read'
        );
        return { items };
      }
      return {
        items,
        watched: {
          movies: library
            .filter((item) => isMovie(item) && item.state.timesWatched > 0)
            .map((item) => item._id)
            .sort(),
          episodes: shows.flatMap((item) => episodesOf.get(item._id)!),
          nextUp: nextUpOf(shows, episodesOf),
        },
        watchlist: config.library ? watchlistOf(library) : undefined,
      };
    },
  };
}
