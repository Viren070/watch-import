import { inflateSync } from 'node:zlib';

/**
 * Stremio's watched bitfield: one bit per video in the order of
 * {@link bitfieldOrder}, serialized as `{anchorVideoId}:{anchorLength}:{zlib+base64}`.
 * The anchor is the last watched video, so a meta that gained or lost videos
 * before it still lines up.
 */
export class WatchedBitField {
  private index?: Map<string, number>;

  private constructor(
    readonly videoIds: string[],
    private values: Uint8Array
  ) {}

  static empty(videoIds: string[]): WatchedBitField {
    return new WatchedBitField(
      videoIds,
      new Uint8Array(Math.ceil(videoIds.length / 8))
    );
  }

  /** An unreadable field or an anchor the meta no longer lists decodes as nothing watched, as in Stremio. */
  static decode(
    serialized: string | null | undefined,
    videoIds: string[]
  ): WatchedBitField {
    const empty = WatchedBitField.empty(videoIds);
    const parts = serialized?.split(':') ?? [];
    if (parts.length < 3) return empty;
    const encoded = parts.pop()!;
    const anchorLength = Number(parts.pop());
    const anchor = videoIds.indexOf(parts.join(':'));
    if (!Number.isInteger(anchorLength) || anchor === -1) return empty;

    let stored: Uint8Array;
    try {
      stored = inflateSync(Buffer.from(encoded, 'base64'));
    } catch {
      return empty;
    }
    const values = new Uint8Array(
      Math.max(stored.length, Math.ceil(videoIds.length / 8))
    );
    values.set(stored);
    const decoded = new WatchedBitField(videoIds, values);

    const offset = anchorLength - anchor - 1;
    if (offset === 0) return decoded;
    for (let i = 0; i < videoIds.length; i++) {
      const previous = i + offset;
      empty.set(
        i,
        previous >= 0 && previous < videoIds.length && decoded.get(previous)
      );
    }
    return empty;
  }

  get(index: number): boolean {
    const byte = index >> 3;
    return (
      byte < this.values.length &&
      ((this.values[byte] >> (index & 7)) & 1) === 1
    );
  }

  set(index: number, watched: boolean): void {
    const byte = index >> 3;
    if (byte >= this.values.length) {
      const grown = new Uint8Array(byte + 1);
      grown.set(this.values);
      this.values = grown;
    }
    if (watched) this.values[byte] |= 1 << (index & 7);
    else this.values[byte] &= ~(1 << (index & 7));
  }

  private indexOf(videoId: string): number {
    if (!this.index) {
      this.index = new Map();
      this.videoIds.forEach((id, i) => {
        if (!this.index!.has(id)) this.index!.set(id, i);
      });
    }
    return this.index.get(videoId) ?? -1;
  }

  has(videoId: string): boolean {
    const index = this.indexOf(videoId);
    return index !== -1 && this.get(index);
  }

  watchedIds(): string[] {
    return this.videoIds.filter((_, i) => this.get(i));
  }
}
