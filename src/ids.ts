/** Splits as AIOStreams does: `kitsu:42323:7` is episode 7 with no season. */
export function splitVideoId(videoId: string): {
  metaId: string;
  season: number | null;
  episode: number | null;
} {
  const parts = videoId.split(':');
  const tail: number[] = [];
  while (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    if (parts.length === 2 && !/^tt\d+$/.test(parts[0])) break;
    tail.unshift(Number(parts.pop()));
  }
  const metaId = parts.join(':');
  if (tail.length >= 2) return { metaId, season: tail[0], episode: tail[1] };
  if (tail.length === 1) return { metaId, season: null, episode: tail[0] };
  return { metaId, season: null, episode: null };
}

export function isImdbId(id: string): boolean {
  return /^tt\d+$/.test(id);
}
