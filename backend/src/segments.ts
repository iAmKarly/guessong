/**
 * Picks which part of a song players hear.
 *
 * Today: a deterministic rule — same song, same segment, every time, which
 * keeps games reproducible and tests stable.
 *
 * This is the seam where the guessability model lands (Milestone 9). Replacing
 * the body of `selectSegment` with a model's prediction requires no changes
 * anywhere else, which is the whole point of keeping it here alone.
 */
import type { Song } from '../../shared/types.ts';
import { config } from '../../shared/config.ts';

const LONGEST_CLIP = Math.max(...config.clipDurations);

/** For tracks of unknown length: skip intros, avoid outros. In seconds. */
const UNKNOWN_EARLIEST = 20;
const UNKNOWN_LATEST = 70;

/**
 * Where the clip starts, in seconds. Always leaves room for the longest clip,
 * so "hear more" never runs off the end of the track.
 *
 * ponytail: hash the song ID into the first half of the track. A real model
 * would listen to the audio; this only has to vary the start and stay in
 * bounds.
 */
export function selectSegment(song: Song): number {
  if (song.duration === null) {
    return UNKNOWN_EARLIEST + (hash(song.id) % (UNKNOWN_LATEST - UNKNOWN_EARLIEST));
  }

  const latest = Math.max(0, Math.min(song.duration - LONGEST_CLIP, song.duration / 2));
  // Work in tenths of a second so short tracks still get some spread.
  return (hash(song.id) % (Math.floor(latest * 10) + 1)) / 10;
}

/** FNV-1a, for a stable spread across IDs. Not security-relevant. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}
