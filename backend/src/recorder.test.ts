import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import type pg from 'pg';

import { config } from '../../shared/config.ts';
import type { Player, Song } from '../../shared/types.ts';
import { setAudioProvider, type AudioProvider } from './audio.ts';
import { migrate, pool, usePool } from './db.ts';
import { extendClip, startGame, submitGuess } from './game.ts';
import { enableRecording, flushRecording, recordPlayer } from './recorder.ts';
import { addPlayer, getRoom, resetRooms } from './rooms.ts';

/**
 * Runs the real migrations and the real recorder against pg-mem, an in-memory
 * Postgres emulator. Not a perfect stand-in for Postgres, but it catches typos,
 * wrong column names, and broken foreign keys without needing Docker.
 */

const songs: Song[] = Array.from({ length: config.rounds }, (_, i) => ({
  id: `test:${i}`,
  title: `Test Song ${i}`,
  artist: 'Tester',
  album: null,
  artworkUrl: null,
  audioSource: null,
  audioProvider: 'test',
  duration: 30,
  aliases: [],
}));

const provider: AudioProvider = {
  name: 'test',
  pickSongs: async (count) => songs.slice(0, count),
  prepare: async () => {},
  getClip: async () => ({ contentType: 'audio/wav', data: Buffer.alloc(0) }),
  search: async () => [],
  getArtwork: async () => null,
};

const player = (id: string): Player => ({ id, name: id, avatarUrl: null, score: 0, connected: true });

async function rows<T>(sql: string): Promise<T[]> {
  return (await pool!.query(sql)).rows as T[];
}

before(async () => {
  // pg-mem wrongly rejects re-running CREATE TABLE IF NOT EXISTS on an
  // existing table; real Postgres skips it, which is what migrate relies on.
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  usePool(new Pool() as pg.Pool);
  await migrate();
  enableRecording();
  setAudioProvider(provider);
});

after(() => {
  usePool(null);
  mock.timers.reset();
});

test('migrations are recorded, and running them again changes nothing', async () => {
  await migrate();
  const applied = await rows<{ name: string }>('SELECT name FROM schema_migrations');
  assert.deepEqual(
    applied.map((row) => row.name),
    ['001_initial.sql'],
  );
});

test('a played game is saved: game, rounds, songs and every guess', async () => {
  resetRooms();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const room = getRoom('channel-1');
  for (const id of ['alice', 'bob']) {
    addPlayer(room, player(id));
    recordPlayer(player(id));
  }

  await startGame(room, () => {});
  mock.timers.tick(config.countdownMs);

  // Round 1: Alice is wrong, then right after a longer clip; Bob is right fast.
  const title = room.round!.song.title;
  submitGuess(room, 'alice', 'not it', () => {});
  submitGuess(room, 'bob', title, () => {});
  mock.timers.tick(2_000);
  extendClip(room, 'alice', () => {});
  submitGuess(room, 'alice', title, () => {});

  // Play out the rest of the game with nobody guessing.
  for (let i = 1; i < config.rounds; i++) {
    mock.timers.tick(config.revealDurationMs);
    mock.timers.tick(config.roundDurationMs);
  }
  mock.timers.tick(config.revealDurationMs);
  assert.equal(room.status, 'FINISHED');
  await flushRecording();
  mock.timers.reset();

  const [game] = await rows<{ category_id: string; host_id: string; finished_at: Date | null }>(
    'SELECT category_id, host_id, finished_at FROM games',
  );
  assert.equal(game!.category_id, config.categories[0].id);
  assert.equal(game!.host_id, 'alice');
  assert.ok(game!.finished_at, 'a completed game has a finish time');

  const rounds = await rows<{ number: number; ended_at: Date | null }>('SELECT number, ended_at FROM rounds');
  assert.equal(rounds.length, config.rounds);
  assert.ok(rounds.every((round) => round.ended_at));

  const guesses = await rows<{
    player_id: string;
    answer: string;
    normalized_answer: string;
    correct: boolean;
    clip_duration: number;
    points: number;
    response_time_ms: number;
  }>('SELECT * FROM guesses ORDER BY id');
  assert.deepEqual(
    guesses.map((g) => [g.player_id, g.correct, g.clip_duration]),
    [
      ['alice', false, config.clipDurations[0]],
      ['bob', true, config.clipDurations[0]],
      ['alice', true, config.clipDurations[1]],
    ],
  );
  assert.equal(guesses[0]!.normalized_answer, 'not it');
  assert.equal(guesses[0]!.points, 0);
  assert.ok(guesses[1]!.points > guesses[2]!.points, 'faster, shorter-clip answer scored more');
  assert.ok(guesses[2]!.response_time_ms >= 2_000);
});

test('the data answers the questions the model will ask', async () => {
  // "How did performance change with clip duration?" — straight from the table.
  const byClip = await rows<{ clip_duration: number; total: number }>(
    `SELECT clip_duration, count(*)::int AS total FROM guesses
     WHERE correct GROUP BY clip_duration ORDER BY clip_duration`,
  );
  assert.deepEqual(
    byClip.map((row) => [row.clip_duration, row.total]),
    [
      [config.clipDurations[0], 1],
      [config.clipDurations[1], 1],
    ],
  );
});

test('a player rejoining updates their name instead of failing', async () => {
  recordPlayer({ ...player('alice'), name: 'Alice Renamed' });
  await flushRecording();
  const [alice] = await rows<{ name: string }>("SELECT name FROM players WHERE id = 'alice'");
  assert.equal(alice!.name, 'Alice Renamed');
});
