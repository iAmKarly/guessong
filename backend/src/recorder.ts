/**
 * Saves what happens in games: players, songs, games, rounds and every guess.
 *
 * Every call here is fire-and-forget. Writes run one at a time, in the order
 * they were made (a guess can't be written before its round), and a failed
 * write is logged and dropped. The game never waits on the database, so a slow
 * or offline database can't stall a round or crash the server.
 *
 * ponytail: one in-process queue. Lost on a crash, which is acceptable for
 * analytics; a durable queue only if this data ever becomes billing-grade.
 */
import type { Player, Song } from '../../shared/types.ts';
import { pool } from './db.ts';

let enabled = false;

/** Called once migrations succeed. Until then (and without a database) nothing is written. */
export function enableRecording(): void {
  enabled = pool !== null;
}

let queue: Promise<void> = Promise.resolve();

function write(sql: string, params: unknown[]): void {
  const db = pool;
  if (!enabled || !db) return;
  queue = queue
    .then(() => db.query(sql, params))
    .then(
      () => {},
      (error: Error) => console.error('[db] write failed:', error.message),
    );
}

/** Resolves once every queued write has finished. For tests and shutdown. */
export function flushRecording(): Promise<void> {
  return queue;
}

export function recordPlayer(player: Player): void {
  write(
    `INSERT INTO players (id, name, avatar_url) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_seen_at = now()`,
    [player.id, player.name, player.avatarUrl],
  );
}

export function recordGameStart(game: {
  id: string;
  roomId: string;
  categoryId: string;
  hostId: string | null;
  startedAt: number;
}): void {
  write(
    `INSERT INTO games (id, room_id, category_id, host_id, started_at) VALUES ($1, $2, $3, $4, $5)`,
    [game.id, game.roomId, game.categoryId, game.hostId, new Date(game.startedAt)],
  );
}

export function recordGameEnd(gameId: string, finishedAt: number): void {
  write(`UPDATE games SET finished_at = $2 WHERE id = $1`, [gameId, new Date(finishedAt)]);
}

export function recordRoundStart(round: {
  id: string;
  gameId: string;
  number: number;
  song: Song;
  segmentStart: number;
  startedAt: number;
}): void {
  const { song } = round;
  write(
    `INSERT INTO songs (id, title, artist, album, artwork_url, audio_source, audio_provider, duration)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title, artist = EXCLUDED.artist, album = EXCLUDED.album,
           artwork_url = EXCLUDED.artwork_url, audio_source = EXCLUDED.audio_source`,
    [song.id, song.title, song.artist, song.album, song.artworkUrl, song.audioSource, song.audioProvider, song.duration],
  );
  write(
    `INSERT INTO rounds (id, game_id, number, song_id, segment_start, started_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [round.id, round.gameId, round.number, song.id, round.segmentStart, new Date(round.startedAt)],
  );
}

export function recordRoundEnd(roundId: string, endedAt: number): void {
  write(`UPDATE rounds SET ended_at = $2 WHERE id = $1`, [roundId, new Date(endedAt)]);
}

export function recordGuess(guess: {
  gameId: string;
  roundId: string;
  playerId: string;
  createdAt: number;
  answer: string;
  normalizedAnswer: string;
  correct: boolean;
  responseTimeMs: number;
  clipDuration: number;
  segmentStart: number;
  points: number;
}): void {
  write(
    `INSERT INTO guesses (game_id, round_id, player_id, created_at, answer, normalized_answer,
                          correct, response_time_ms, clip_duration, segment_start, points)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      guess.gameId,
      guess.roundId,
      guess.playerId,
      new Date(guess.createdAt),
      guess.answer,
      guess.normalizedAnswer,
      guess.correct,
      Math.round(guess.responseTimeMs),
      guess.clipDuration,
      guess.segmentStart,
      guess.points,
    ],
  );
}
