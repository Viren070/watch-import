/** Times are in milliseconds, dates are ISO strings. */
export interface LibraryItemState {
  lastWatched?: string | null;
  timeWatched: number;
  timeOffset: number;
  overallTimeWatched: number;
  timesWatched: number;
  flaggedWatched: number;
  duration: number;
  video_id?: string | null;
  watched?: string | null;
  noNotif?: boolean;
  [key: string]: unknown;
}

export interface LibraryItem {
  _id: string;
  name: string;
  type: string;
  poster?: string | null;
  posterShape?: string;
  removed: boolean;
  temp: boolean;
  _ctime?: string | null;
  _mtime: string;
  state: LibraryItemState;
  behaviorHints?: Record<string, unknown>;
  [key: string]: unknown;
}

const COUNTERS = [
  'timeWatched',
  'timeOffset',
  'overallTimeWatched',
  'timesWatched',
  'flaggedWatched',
  'duration',
] as const;

export function normaliseItem(item: LibraryItem): LibraryItem {
  const state = { ...item.state };
  for (const key of COUNTERS) {
    const value = Number(state[key]);
    state[key] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }
  return { ...item, state };
}

export function timeOf(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Live channels and `other` never hold watch state in Stremio. */
export function isTrackable(item: Pick<LibraryItem, 'type' | 'behaviorHints'>) {
  return (
    item.type !== 'other' &&
    item.type !== 'tv' &&
    item.type !== 'channel' &&
    item.behaviorHints?.isLive !== true
  );
}

export function isInContinueWatching(item: LibraryItem): boolean {
  return (!item.removed || item.temp) && item.state.timeOffset > 0;
}
