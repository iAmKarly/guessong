/**
 * Real songs, from Deezer's public API: no account, no key, a 30-second
 * preview for almost every track. Categories map to charts and playlists below.
 *
 * The server downloads and decodes each preview, then serves only the slice a
 * player has unlocked (see audio.ts). Players never receive the preview URL,
 * the full preview, or anything that names the song.
 *
 * Licensing: Deezer's terms are written with "promote the track" uses in mind.
 * Fine for testing with friends; read them before publishing publicly.
 */
import { MPEGDecoder } from 'mpg123-decoder';

import type { Song, Suggestion } from '../../shared/types.ts';
import { AudioUnavailableError, cutClip, type AudioProvider, type Pcm } from './audio.ts';
import { normalize, plainTitle } from './matching.ts';

const API = 'https://api.deezer.com';

/**
 * How each category in shared/config.ts finds its songs: Deezer's live chart,
 * or a playlist search ("2000s hits"). Searching rather than hard-coding
 * playlist IDs means nothing breaks when Deezer retires a playlist.
 *
 * To pin a category to one exact playlist, use `{ playlist: <id> }`, with the
 * number from the playlist's URL on deezer.com.
 */
type Source = { chart: true } | { search: string } | { playlist: number };

export const SOURCES: Record<string, Source> = {
  top: { chart: true },
  '2020s': { search: '2020s hits' },
  '2010s': { search: '2010s hits' },
  '2000s': { search: '2000s hits' },
  '90s': { search: '90s hits' },
  '80s': { search: '80s hits' },
  pop: { search: 'pop hits' },
  rock: { search: 'rock classics' },
  hiphop: { search: 'hip hop hits' },
  dance: { search: 'dance hits' },
};

/** A playlist needs at least this many tracks to be worth picking. */
const MIN_PLAYLIST_TRACKS = 30;

/** Previews are 30 seconds; clips are cut from inside that window. */
const PREVIEW_SECONDS = 30;

const TIMEOUT_MS = 8_000;
const CHART_TTL_MS = 60 * 60 * 1000;

/**
 * Decoded previews kept in memory. ~2.6 MB each.
 *
 * ponytail: insertion-order eviction, in memory. Enough for a few concurrent
 * games; a disk or Redis cache only if many games run at once.
 */
const MAX_CACHED_PREVIEWS = 30;

type DeezerTrack = {
  id?: unknown;
  title?: unknown;
  title_short?: unknown;
  preview?: unknown;
  artist?: { name?: unknown };
  album?: { title?: unknown; cover_medium?: unknown };
};

/**
 * Deezer's track list → our songs. Drops anything incomplete, and anything
 * whose preview isn't on Deezer's CDN — we fetch those URLs server-side, so
 * they must not point anywhere else.
 */
export function toSongs(json: unknown): Song[] {
  const data = (json as { data?: unknown } | null)?.data;
  // Deezer reports errors as HTTP 200 with an `error` object instead of `data`.
  if (!Array.isArray(data)) throw new AudioUnavailableError();

  return data.flatMap((raw: DeezerTrack): Song[] => {
    const { id, title, title_short, preview, artist, album } = raw ?? {};
    if (typeof id !== 'number' || typeof title !== 'string') return [];
    if (typeof artist?.name !== 'string' || !isDeezerCdn(preview)) return [];

    return [
      {
        id: `deezer:${id}`,
        title,
        artist: artist.name,
        album: typeof album?.title === 'string' ? album.title : null,
        artworkUrl: typeof album?.cover_medium === 'string' ? album.cover_medium : null,
        audioSource: preview,
        audioProvider: 'deezer',
        duration: PREVIEW_SECONDS,
        // "Song (feat. X)" ships with a title_short of just "Song".
        aliases: typeof title_short === 'string' && title_short !== title ? [title_short] : [],
      },
    ];
  });
}

export function isDeezerCdn(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname.endsWith('.dzcdn.net');
  } catch {
    return false;
  }
}

/** fetch, with every network failure reported as "the music server is down". */
async function download(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    console.error(`[deezer] request failed: ${(error as Error).message}`);
    throw new AudioUnavailableError();
  }
  if (!response.ok) {
    console.error(`[deezer] HTTP ${response.status}`);
    throw new AudioUnavailableError();
  }
  return response;
}

type PlaylistResult = { id?: unknown; nb_tracks?: unknown; user?: { name?: unknown } };

/**
 * Pick the best playlist from a Deezer search: Deezer's own editorial
 * playlists first, then any big enough one, then whatever came first.
 */
export function choosePlaylist(json: unknown): number {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new AudioUnavailableError();

  const playlists = data.filter(
    (p: PlaylistResult | null): p is PlaylistResult & { id: number } => typeof p?.id === 'number',
  );
  const bigEnough = (p: PlaylistResult) => Number(p.nb_tracks) >= MIN_PLAYLIST_TRACKS;
  const pick =
    playlists.find((p) => p.user?.name === 'Deezer' && bigEnough(p)) ??
    playlists.find(bigEnough) ??
    playlists[0];

  if (!pick) throw new AudioUnavailableError('No songs found for that category');
  return pick.id;
}

async function getJson(url: string): Promise<unknown> {
  return (await download(url)).json();
}

async function tracksUrl(source: Source): Promise<string> {
  if ('chart' in source) return `${API}/chart/0/tracks?limit=100`;
  const playlist =
    'playlist' in source
      ? source.playlist
      : choosePlaylist(await getJson(`${API}/search/playlist?q=${encodeURIComponent(source.search)}&limit=25`));
  return `${API}/playlist/${playlist}/tracks?limit=100`;
}

const catalogs = new Map<string, { songs: Song[]; fetchedAt: number }>();

async function catalog(categoryId: string): Promise<Song[]> {
  const cached = catalogs.get(categoryId);
  if (cached && Date.now() - cached.fetchedAt < CHART_TTL_MS) return cached.songs;

  const source = SOURCES[categoryId];
  if (!source) throw new AudioUnavailableError('Unknown category');

  const songs = toSongs(await getJson(await tracksUrl(source)));
  if (songs.length === 0) throw new AudioUnavailableError('No songs found for that category');
  catalogs.set(categoryId, { songs, fetchedAt: Date.now() });
  return songs;
}

const previews = new Map<string, Promise<Pcm>>();

function preview(song: Song): Promise<Pcm> {
  let pending = previews.get(song.id);
  if (!pending) {
    pending = decodePreview(song);
    // Forget failures, so the next request retries rather than failing forever.
    pending.catch(() => previews.delete(song.id));
    previews.set(song.id, pending);
    if (previews.size > MAX_CACHED_PREVIEWS) {
      previews.delete(previews.keys().next().value!);
    }
  }
  return pending;
}

async function decodePreview(song: Song): Promise<Pcm> {
  if (!isDeezerCdn(song.audioSource)) throw new AudioUnavailableError();
  const mp3 = new Uint8Array(await (await download(song.audioSource)).arrayBuffer());

  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(mp3);
    if (samplesDecoded === 0) throw new AudioUnavailableError();
    return { samples: toMono(channelData, samplesDecoded), sampleRate };
  } finally {
    decoder.free();
  }
}

/** Average the channels into one, as 16-bit integers. */
function toMono(channels: Float32Array[], length: number): Int16Array {
  const mono = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / channels.length));
    mono[i] = Math.round(sample * 32767);
  }
  return mono;
}

// --- Autocomplete -----------------------------------------------------------

const MAX_SUGGESTIONS = 6;

/**
 * Deezer's search results → autocomplete entries. Versions of the same song
 * ("Bohemian Rhapsody - Remastered 2011", "... - Live") collapse into one.
 */
export function toSuggestions(json: unknown): Suggestion[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const results: Suggestion[] = [];
  for (const raw of data as DeezerTrack[]) {
    if (typeof raw?.title !== 'string' || typeof raw.artist?.name !== 'string') continue;
    const suggestion = { title: plainTitle(raw.title) || raw.title, artist: raw.artist.name };
    const key = `${normalize(suggestion.artist)}|${normalize(suggestion.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(suggestion);
    if (results.length === MAX_SUGGESTIONS) break;
  }
  return results;
}

/**
 * Deezer limits how often one server may call it, and every player's typing
 * goes through this server, so cap our own rate well below theirs. Over the
 * budget, autocomplete just comes back empty for a moment.
 *
 * ponytail: one global window, in memory. Per-player budgets if one player's
 * typing ever starves everyone else's.
 */
const SEARCH_BUDGET = { requests: 20, perMs: 5_000 };
const recentSearches: number[] = [];

function withinBudget(): boolean {
  const now = Date.now();
  while (recentSearches.length > 0 && now - recentSearches[0]! > SEARCH_BUDGET.perMs) {
    recentSearches.shift();
  }
  if (recentSearches.length >= SEARCH_BUDGET.requests) return false;
  recentSearches.push(now);
  return true;
}

/** ponytail: insertion-order cache, capped. Popular searches repeat a lot. */
const searchCache = new Map<string, Suggestion[]>();
const MAX_CACHED_SEARCHES = 500;

async function search(query: string): Promise<Suggestion[]> {
  const key = normalize(query);
  if (key.length < 2) return [];

  const cached = searchCache.get(key);
  if (cached) return cached;
  if (!withinBudget()) return [];

  let results: Suggestion[];
  try {
    results = toSuggestions(await getJson(`${API}/search?q=${encodeURIComponent(key)}&limit=25`));
  } catch {
    // Autocomplete is a nicety: a failure means no suggestions, not an error.
    return [];
  }

  searchCache.set(key, results);
  if (searchCache.size > MAX_CACHED_SEARCHES) searchCache.delete(searchCache.keys().next().value!);
  return results;
}

/** Album covers are small; anything bigger isn't one. */
const MAX_ARTWORK_BYTES = 2 * 1024 * 1024;

async function getArtwork(url: string) {
  // Only Deezer's own CDN, or this would fetch any URL a client asked for.
  if (!isDeezerCdn(url)) return null;
  try {
    const response = await download(url);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    const data = Buffer.from(await response.arrayBuffer());
    return data.length <= MAX_ARTWORK_BYTES ? { contentType, data } : null;
  } catch {
    return null; // A missing cover just isn't shown.
  }
}

export const deezerProvider: AudioProvider = {
  name: 'deezer',

  async pickSongs(count, categoryId) {
    const pool = [...(await catalog(categoryId))];
    // Fisher-Yates.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, count);
  },

  async prepare(song) {
    await preview(song);
  },

  async getClip(song, start, duration) {
    return cutClip(await preview(song), start, duration);
  },

  search,
  getArtwork,
};
