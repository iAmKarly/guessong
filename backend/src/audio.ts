/**
 * Where audio comes from, and how a player gets their clip.
 *
 * The game only ever talks to `audioProvider`. Changing the music source means
 * writing another AudioProvider and passing it to setAudioProvider in index.ts
 * — nothing in the game engine changes.
 */
import { randomBytes } from 'node:crypto';

import type { Song, Suggestion } from '../../shared/types.ts';

export type Clip = { contentType: string; data: Buffer };

/** 16-bit mono audio. */
export type Pcm = { samples: Int16Array; sampleRate: number };

export interface AudioProvider {
  readonly name: string;
  /**
   * Songs for one game from a category in config.categories, shuffled. Throws
   * AudioUnavailableError when the source is down.
   */
  pickSongs(count: number, categoryId: string): Promise<Song[]>;
  /** Start loading a song's audio, so its first clip comes back quickly. */
  prepare(song: Song): Promise<void>;
  /** Exactly `duration` seconds starting at `start`, never more. */
  getClip(song: Song, start: number, duration: number): Promise<Clip>;
  /**
   * Autocomplete across the provider's whole catalog. Must never depend on the
   * current game, or the suggestions would give the answer away.
   */
  search(query: string): Promise<Suggestion[]>;
  /**
   * An album cover, fetched server-side because Discord's sandbox blocks
   * outside images. Null for anything that isn't this provider's own image.
   */
  getArtwork(url: string): Promise<Clip | null>;
}

/** The music source can't be reached. The message is safe to show players. */
export class AudioUnavailableError extends Error {
  constructor(message = 'Music server is down — try again in a bit') {
    super(message);
  }
}

/** Fails loudly until index.ts (or a test) chooses a real provider. */
const unconfigured: AudioProvider = {
  name: 'unconfigured',
  pickSongs: () => Promise.reject(new Error('No audio provider configured')),
  prepare: () => Promise.resolve(),
  getClip: () => Promise.reject(new Error('No audio provider configured')),
  search: () => Promise.resolve([]),
  getArtwork: () => Promise.resolve(null),
};

export let audioProvider: AudioProvider = unconfigured;

/** Chosen once at startup by index.ts; tests pass a fake so they never touch the network. */
export function setAudioProvider(provider: AudioProvider): void {
  audioProvider = provider;
}

// --- Clip tickets -----------------------------------------------------------
// A ticket is the only way to get audio. It is random, so the URL says nothing
// about the song, and it pins the start and length server-side, so a client
// can't ask for more of the track than it has unlocked.

type Ticket = { song: Song; start: number; duration: number; expiresAt: number };

const tickets = new Map<string, Ticket>();

export function issueClip(ticket: Ticket): string {
  // ponytail: prune on write. Fine at party-game volume; a timer sweep if not.
  const now = Date.now();
  for (const [token, existing] of tickets) if (existing.expiresAt <= now) tickets.delete(token);

  const token = randomBytes(18).toString('base64url');
  tickets.set(token, ticket);
  return token;
}

export function redeemClip(token: string): Ticket | null {
  const ticket = tickets.get(token);
  if (!ticket || ticket.expiresAt <= Date.now()) return null;
  return ticket;
}

/** Test seam. */
export function resetClips(): void {
  tickets.clear();
}

// --- Cutting clips ----------------------------------------------------------

/** Fade length at each end, so a clip cut mid-note doesn't click. */
const FADE_SECONDS = 0.005;

/** A WAV of `duration` seconds from `start`, clamped to the audio that exists. */
export function cutClip({ samples, sampleRate }: Pcm, start: number, duration: number): Clip {
  const from = Math.min(samples.length, Math.max(0, Math.round(start * sampleRate)));
  const to = Math.min(samples.length, from + Math.round(duration * sampleRate));
  const clip = samples.slice(from, to); // a copy, so fading can't touch the cached audio

  const fade = Math.min(Math.round(FADE_SECONDS * sampleRate), Math.floor(clip.length / 2));
  for (let i = 0; i < fade; i++) {
    const gain = i / fade;
    clip[i] = Math.round(clip[i]! * gain);
    clip[clip.length - 1 - i] = Math.round(clip[clip.length - 1 - i]! * gain);
  }

  return { contentType: 'audio/wav', data: encodeWav(clip, sampleRate) };
}

export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
}
