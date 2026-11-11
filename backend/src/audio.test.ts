import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../shared/config.ts';
import { AudioUnavailableError, cutClip, issueClip, redeemClip, resetClips } from './audio.ts';
import { choosePlaylist, SOURCES, toSongs, toSuggestions } from './deezer.ts';
import { isCorrect } from './matching.ts';
import { selectSegment } from './segments.ts';

const LONGEST_CLIP = Math.max(...config.clipDurations);

/** Shaped like a real api.deezer.com/chart response, trimmed. */
const chart = {
  data: [
    {
      id: 908604612,
      title: 'Blinding Lights',
      title_short: 'Blinding Lights',
      preview: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/abc.mp3',
      artist: { name: 'The Weeknd' },
      album: { title: 'After Hours', cover_medium: 'https://cdn-images.dzcdn.net/x.jpg' },
    },
    {
      id: 2,
      title: 'Stay (feat. Someone)',
      title_short: 'Stay',
      preview: 'https://cdns-preview-1.dzcdn.net/stream/stay.mp3',
      artist: { name: 'Somebody' },
    },
    // Each of these must be dropped.
    { id: 3, title: 'No preview', preview: '', artist: { name: 'x' } },
    { id: 4, title: 'Elsewhere', preview: 'https://evil.example/x.mp3', artist: { name: 'x' } },
    { id: 5, title: 'Plain HTTP', preview: 'http://cdns-preview-1.dzcdn.net/x.mp3', artist: { name: 'x' } },
    { id: 6, title: 'No artist', preview: 'https://cdns-preview-1.dzcdn.net/x.mp3' },
    { title: 'No id', preview: 'https://cdns-preview-1.dzcdn.net/x.mp3', artist: { name: 'x' } },
    null,
  ],
};

afterEach(() => {
  mock.timers.reset();
  resetClips();
});

test('Deezer tracks become songs, keeping only complete ones on Deezer’s CDN', () => {
  const songs = toSongs(chart);
  assert.deepEqual(
    songs.map((song) => song.title),
    ['Blinding Lights', 'Stay (feat. Someone)'],
  );

  const [blinding] = songs;
  assert.equal(blinding!.id, 'deezer:908604612');
  assert.equal(blinding!.artist, 'The Weeknd');
  assert.equal(blinding!.album, 'After Hours');
  assert.equal(blinding!.audioProvider, 'deezer');
  assert.deepEqual(blinding!.aliases, [], 'no alias when the short title is identical');
});

test('the short title is accepted as an answer', () => {
  const stay = toSongs(chart)[1]!;
  assert.deepEqual(stay.aliases, ['Stay']);
  assert.ok(isCorrect('stay', stay));
  assert.ok(isCorrect('Stay (feat. Someone)', stay));
});

test('a Deezer error payload means the music server is down', () => {
  assert.throws(() => toSongs({ error: { type: 'Exception', code: 4 } }), AudioUnavailableError);
  assert.throws(() => toSongs(null), AudioUnavailableError);
});

test('the chosen segment always fits the longest clip inside a preview', () => {
  for (const song of toSongs(chart)) {
    const start = selectSegment(song);
    assert.ok(start >= 0);
    assert.ok(start + LONGEST_CLIP <= song.duration!, `${start}s + ${LONGEST_CLIP}s`);
  }
});

// --- Cutting clips ----------------------------------------------------------

const SAMPLE_RATE = 8_000;
/** Ten seconds of a loud constant tone, so fades and slices are easy to see. */
const pcm = { samples: new Int16Array(10 * SAMPLE_RATE).fill(10_000), sampleRate: SAMPLE_RATE };

test('a clip is a valid WAV of exactly the requested length', () => {
  for (const duration of config.clipDurations) {
    const { contentType, data } = cutClip(pcm, 1, duration);
    assert.equal(contentType, 'audio/wav');
    assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    assert.equal(data.toString('ascii', 8, 12), 'WAVE');
    assert.equal(data.readUInt32LE(24), SAMPLE_RATE);
    assert.equal(data.readUInt32LE(40), Math.round(duration * SAMPLE_RATE) * 2, `${duration}s`);
  }
});

test('a clip never runs past the end of the audio', () => {
  const { data } = cutClip(pcm, 9, 5);
  assert.equal(data.readUInt32LE(40), 1 * SAMPLE_RATE * 2);
  assert.equal(cutClip(pcm, 50, 5).data.readUInt32LE(40), 0);
});

test('clips fade at the edges, without touching the cached audio', () => {
  const { data } = cutClip(pcm, 0, 1);
  const samples = new Int16Array(data.buffer.slice(data.byteOffset + 44, data.byteOffset + data.length));
  assert.equal(samples[0], 0, 'starts silent');
  assert.equal(samples[samples.length / 2], 10_000, 'full volume in the middle');
  assert.equal(pcm.samples[0], 10_000, 'source untouched');
});

// --- Tickets ----------------------------------------------------------------

const song = toSongs(chart)[0]!;

test('tickets redeem until they expire', () => {
  mock.timers.enable({ apis: ['Date'] });
  const token = issueClip({ song, start: 0, duration: 1, expiresAt: Date.now() + 1_000 });

  assert.equal(redeemClip(token)?.song.id, song.id);
  mock.timers.tick(1_000);
  assert.equal(redeemClip(token), null);
});

test('tickets are unguessable and say nothing about the song', () => {
  const a = issueClip({ song, start: 0, duration: 1, expiresAt: Date.now() + 1_000 });
  const b = issueClip({ song, start: 0, duration: 1, expiresAt: Date.now() + 1_000 });
  assert.notEqual(a, b);
  assert.ok(a.length >= 20);
  assert.equal(a.toLowerCase().includes('blinding'), false);
  assert.equal(a.includes('908604612'), false);
  assert.equal(redeemClip('not-a-real-ticket'), null);
});

// --- Categories -------------------------------------------------------------

test('every category the host can pick has somewhere to get songs', () => {
  for (const category of config.categories) {
    assert.ok(SOURCES[category.id], `no Deezer source for "${category.id}"`);
  }
});

test("a playlist search prefers Deezer's own big playlists", () => {
  const results = {
    data: [
      { id: 1, nb_tracks: 8, user: { name: 'Deezer' } }, // editorial but tiny
      { id: 2, nb_tracks: 200, user: { name: 'some fan' } },
      { id: 3, nb_tracks: 80, user: { name: 'Deezer' } },
    ],
  };
  assert.equal(choosePlaylist(results), 3);
});

test('a playlist search falls back to any big playlist, then to anything', () => {
  assert.equal(choosePlaylist({ data: [{ id: 1, nb_tracks: 5 }, { id: 2, nb_tracks: 50 }] }), 2);
  assert.equal(choosePlaylist({ data: [{ id: 7, nb_tracks: 5 }] }), 7);
});

test('a playlist search with no results is reported, not crashed on', () => {
  assert.throws(() => choosePlaylist({ data: [] }), /no songs found/i);
  assert.throws(() => choosePlaylist({ error: {} }), AudioUnavailableError);
});

// --- Autocomplete -------------------------------------------------------------

test('search results become plain, de-duplicated suggestions', () => {
  const results = toSuggestions({
    data: [
      { title: 'Bohemian Rhapsody - Remastered 2011', artist: { name: 'Queen' } },
      { title: 'Bohemian Rhapsody (Live Aid)', artist: { name: 'Queen' } },
      { title: 'Bohemian Rhapsody', artist: { name: 'Queen' } },
      { title: 'Bohemian Rhapsody', artist: { name: 'Panic! At The Disco' } },
      { title: 'Somebody to Love', artist: { name: 'Queen' } },
      { title: 'no artist' },
      null,
    ],
  });
  assert.deepEqual(results, [
    { title: 'Bohemian Rhapsody', artist: 'Queen' },
    { title: 'Bohemian Rhapsody', artist: 'Panic! At The Disco' },
    { title: 'Somebody to Love', artist: 'Queen' },
  ]);
});

test('suggestions are capped, and a broken response means none', () => {
  const many = { data: Array.from({ length: 20 }, (_, i) => ({ title: `Song ${i}`, artist: { name: 'x' } })) };
  assert.equal(toSuggestions(many).length, 6);
  assert.deepEqual(toSuggestions({ error: {} }), []);
});

test('picking a suggestion counts as the right answer for any version', () => {
  const [pick] = toSuggestions({ data: [{ title: 'Bohemian Rhapsody - Live', artist: { name: 'Queen' } }] });
  const roundSong = { title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen' };
  assert.ok(isCorrect(`${pick!.artist} - ${pick!.title}`, roundSong));
});

test('artwork is only ever fetched from Deezer’s own CDN', async () => {
  const { deezerProvider } = await import('./deezer.ts');
  for (const url of [
    'https://evil.example/cover.jpg',
    'http://cdn-images.dzcdn.net/cover.jpg',
    'https://dzcdn.net.evil.example/cover.jpg',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.equal(await deezerProvider.getArtwork(url), null, url);
  }
});
