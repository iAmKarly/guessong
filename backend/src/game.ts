/**
 * The game engine: the state machine, its timers, and the rules.
 *
 *   LOBBY -> STARTING -> PLAYING -> REVEALING -> PLAYING -> ... -> FINISHED
 *
 * Everything here is server-side and authoritative. Clients are told what
 * happened; they never decide it. `broadcast` is injected so this module knows
 * nothing about sockets.
 */
import type { Reveal } from '../../shared/types.ts';
import { config } from '../../shared/config.ts';
import { randomUUID } from 'node:crypto';

import { AudioUnavailableError, audioProvider, issueClip } from './audio.ts';
import { isCorrect, normalize } from './matching.ts';
import { recordGameEnd, recordGameStart, recordGuess, recordRoundEnd, recordRoundStart } from './recorder.ts';
import { scoreGuess } from './scoring.ts';
import { selectSegment } from './segments.ts';
import { connectedPlayers, type Room, type RoundRuntime } from './rooms.ts';

export type Broadcast = (room: Room) => void;

/** Tickets outlive their round slightly, so a late fetch still plays. */
const TICKET_GRACE_MS = 5_000;
const LONGEST_CLIP = Math.max(...config.clipDurations);

/**
 * Caller must have checked startBlockedReason first. Resolves to a message for
 * the players if the game couldn't start (the music server is down), else null.
 */
export async function startGame(room: Room, broadcast: Broadcast): Promise<string | null> {
  clearTimer(room);
  room.status = 'STARTING';
  room.round = null;
  room.reveal = null;
  for (const player of room.players.values()) player.score = 0;
  broadcast(room);

  let songs;
  try {
    songs = await audioProvider.pickSongs(config.rounds, room.categoryId);
  } catch (error) {
    if (!(error instanceof AudioUnavailableError)) console.error('[game] could not pick songs:', error);
    if (room.status === 'STARTING') {
      room.status = 'LOBBY';
      broadcast(room);
    }
    return error instanceof AudioUnavailableError ? error.message : new AudioUnavailableError().message;
  }

  // Everyone may have left, or the game been stopped, while songs loaded.
  if (room.status !== 'STARTING' || room.players.size === 0) return null;

  room.songs = songs;
  room.gameId = randomUUID();
  recordGameStart({
    id: room.gameId,
    roomId: room.id,
    categoryId: room.categoryId,
    hostId: room.hostId,
    startedAt: Date.now(),
  });
  // Load audio during the countdown, so round 1's clip arrives quickly.
  for (const song of songs) {
    audioProvider.prepare(song).catch(() => {
      // Surfaces later, as a failed clip the player can see.
    });
  }
  room.countdownEndsAt = Date.now() + config.countdownMs;
  broadcast(room);
  room.timer = setTimeout(() => beginRound(room, 1, broadcast), config.countdownMs);
  return null;
}

/** Stop everything in flight. Used when a room empties out. */
export function stopGame(room: Room): void {
  clearTimer(room);
  room.round = null;
  room.reveal = null;
}

function beginRound(room: Room, number: number, broadcast: Broadcast): void {
  const song = room.songs[number - 1];
  // Fewer songs than rounds (a small catalog) simply ends the game early.
  if (!song) {
    finish(room, broadcast);
    return;
  }

  const startedAt = Date.now();
  room.status = 'PLAYING';
  room.countdownEndsAt = null;
  room.reveal = null;
  room.round = {
    id: randomUUID(),
    number,
    song,
    segmentStart: selectSegment(song),
    startedAt,
    endsAt: startedAt + config.roundDurationMs,
    clipLevel: new Map(),
    clipTokens: new Map(),
    attempts: new Map(),
    tried: new Map(),
    lastGuessAt: new Map(),
    solved: new Map(),
  };
  for (const playerId of room.players.keys()) issuePlayerClip(room.round, playerId);
  if (room.gameId) {
    recordRoundStart({ ...room.round, gameId: room.gameId });
  }

  broadcast(room);
  room.timer = setTimeout(() => endRound(room, broadcast), config.roundDurationMs);
}

function endRound(room: Room, broadcast: Broadcast): void {
  const round = room.round;
  if (!round) return;
  clearTimer(room);
  recordRoundEnd(round.id, Date.now());

  room.status = 'REVEALING';
  room.reveal = buildReveal(room);
  room.round = null;

  broadcast(room);

  const next = round.number + 1;
  room.timer = setTimeout(() => {
    if (next > config.rounds) finish(room, broadcast);
    else beginRound(room, next, broadcast);
  }, config.revealDurationMs);
}

function finish(room: Room, broadcast: Broadcast): void {
  clearTimer(room);
  if (room.gameId) recordGameEnd(room.gameId, Date.now());
  room.gameId = null;
  room.status = 'FINISHED';
  room.round = null;
  room.reveal = null;
  broadcast(room);
}

function buildReveal(room: Room): Reveal {
  const round = room.round!;
  const scores = [...round.solved.entries()]
    .map(([playerId, points]) => ({
      playerId,
      name: room.players.get(playerId)?.name ?? 'Someone',
      points,
    }))
    .sort((a, b) => b.points - a.points);

  return {
    title: round.song.title,
    artist: round.song.artist,
    artworkUrl: round.song.artworkUrl,
    clipToken: issueClip({
      song: round.song,
      start: round.segmentStart,
      duration: LONGEST_CLIP,
      expiresAt: Date.now() + config.revealDurationMs + TICKET_GRACE_MS,
    }),
    scores,
  };
}

/** Whether a player was in the room when this round began, so may play it. */
function inRound(round: RoundRuntime, playerId: string): boolean {
  return round.clipTokens.has(playerId);
}

/** Give a player a ticket for exactly the clip length they've unlocked. */
function issuePlayerClip(round: RoundRuntime, playerId: string): void {
  const level = round.clipLevel.get(playerId) ?? 0;
  round.clipTokens.set(
    playerId,
    issueClip({
      song: round.song,
      start: round.segmentStart,
      duration: config.clipDurations[level]!,
      expiresAt: round.endsAt + TICKET_GRACE_MS,
    }),
  );
}

export type GuessOutcome =
  | { ok: true; correct: boolean; points: number }
  | { ok: false; reason: string };

export function submitGuess(
  room: Room,
  playerId: string,
  text: string,
  broadcast: Broadcast,
): GuessOutcome {
  const round = room.round;
  if (room.status !== 'PLAYING' || !round) return { ok: false, reason: 'No round in progress' };
  if (!room.players.has(playerId)) return { ok: false, reason: 'You are not in this game' };
  if (!inRound(round, playerId)) return { ok: false, reason: "You're in from the next round" };
  if (round.solved.has(playerId)) return { ok: false, reason: 'You already got this one' };

  // Spam protection, all before anything is counted or recorded.
  const now = Date.now();
  if (now - (round.lastGuessAt.get(playerId) ?? -Infinity) < config.guessCooldownMs) {
    return { ok: false, reason: 'Slow down a little' };
  }
  const normalizedAnswer = normalize(text);
  const tried = round.tried.get(playerId) ?? new Set<string>();
  if (tried.has(normalizedAnswer)) {
    return { ok: false, reason: 'You already tried that' };
  }
  const attempts = (round.attempts.get(playerId) ?? 0) + 1;
  if (attempts > config.maxGuessesPerRound) {
    return { ok: false, reason: 'No guesses left this round' };
  }
  round.attempts.set(playerId, attempts);
  round.lastGuessAt.set(playerId, now);
  round.tried.set(playerId, tried.add(normalizedAnswer));

  const clipLevel = round.clipLevel.get(playerId) ?? 0;
  const correct = isCorrect(text, round.song);
  const points = correct
    ? scoreGuess({ elapsedMs: now - round.startedAt, roundDurationMs: config.roundDurationMs, clipLevel })
    : 0;

  // Every guess, right or wrong, is training data for the guessability model.
  if (room.gameId) {
    recordGuess({
      gameId: room.gameId,
      roundId: round.id,
      playerId,
      createdAt: now,
      answer: text,
      normalizedAnswer,
      correct,
      responseTimeMs: now - round.startedAt,
      clipDuration: config.clipDurations[clipLevel]!,
      segmentStart: round.segmentStart,
      points,
    });
  }

  if (!correct) {
    // Deliberately no state broadcast: a wrong guess is private, and telling
    // the room would leak how close someone is.
    return { ok: true, correct: false, points: 0 };
  }

  round.solved.set(playerId, points);
  const player = room.players.get(playerId);
  if (player) player.score += points;

  if (!endIfEveryoneSolved(room, broadcast)) broadcast(room);

  return { ok: true, correct: true, points };
}

/**
 * End the round early once every connected player has the answer — there's no
 * reason to run the clock down. Also called when someone drops out, since the
 * players left may all have solved it already. Returns true if it ended.
 */
export function endIfEveryoneSolved(room: Room, broadcast: Broadcast): boolean {
  const round = room.round;
  if (room.status !== 'PLAYING' || !round) return false;
  // Only players who were there when the round began; latecomers sit it out.
  const online = connectedPlayers(room).filter((player) => inRound(round, player.id));
  if (online.length === 0 || !online.every((player) => round.solved.has(player.id))) return false;
  endRound(room, broadcast);
  return true;
}

/** Longer clip, fewer available points. Returns an error message, or null. */
export function extendClip(room: Room, playerId: string, broadcast: Broadcast): string | null {
  const round = room.round;
  if (room.status !== 'PLAYING' || !round) return 'No round in progress';
  if (!inRound(round, playerId)) return "You're in from the next round";
  if (round.solved.has(playerId)) return 'You already got this one';

  const level = round.clipLevel.get(playerId) ?? 0;
  if (level >= config.clipDurations.length - 1) return 'That is the whole clip';

  round.clipLevel.set(playerId, level + 1);
  issuePlayerClip(round, playerId);
  broadcast(room);
  return null;
}

function clearTimer(room: Room): void {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
