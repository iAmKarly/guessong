import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../shared/config.ts';
import type { Player } from '../../shared/types.ts';
import { endIfEveryoneSolved, extendClip, startGame, stopGame, submitGuess } from './game.ts';
import { AudioUnavailableError, redeemClip, setAudioProvider, type AudioProvider } from './audio.ts';
import type { Song } from '../../shared/types.ts';
import { addPlayer, getRoom, publicState, removePlayer, resetRooms, setConnected, type Room } from './rooms.ts';

const player = (id: string): Player => ({ id, name: id, avatarUrl: null, score: 0, connected: true });

/** Counts broadcasts so we can assert the room is actually told about changes. */
let broadcasts: number;
const broadcast = () => {
  broadcasts++;
};

function twoPlayerRoom(): Room {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  addPlayer(room, player('b'));
  return room;
}

/** The current round's answer, which only tests are allowed to peek at. */
function answer(room: Room): string {
  return room.round!.song.title;
}

/** Stands in for Deezer, so tests are fast, deterministic, and offline. */
let musicServerDown = false;
let requestedCategory: string | null = null;
const songs: Song[] = Array.from({ length: 12 }, (_, i) => ({
  id: `test:${i}`,
  title: `Test Song ${i}`,
  artist: `Artist ${i}`,
  album: null,
  artworkUrl: null,
  audioSource: null,
  audioProvider: 'test',
  duration: 30,
  aliases: [],
}));
const fakeProvider: AudioProvider = {
  name: 'test',
  pickSongs: async (count, categoryId) => {
    requestedCategory = categoryId;
    if (musicServerDown) throw new AudioUnavailableError();
    return songs.slice(0, count);
  },
  prepare: async () => {},
  getClip: async () => ({ contentType: 'audio/wav', data: Buffer.alloc(0) }),
  search: async () => [],
  getArtwork: async () => null,
};

beforeEach(() => {
  broadcasts = 0;
  musicServerDown = false;
  setAudioProvider(fakeProvider);
  resetRooms();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
});

afterEach(() => {
  mock.timers.reset();
});

test('starting moves through the countdown into the first round', async () => {
  const room = twoPlayerRoom();

  await startGame(room, broadcast);
  assert.equal(room.status, 'STARTING');
  // Not `assert.equal(room.round, null)`: node's assert types narrow the value
  // to null for the rest of the test, which breaks the check below.
  assert.equal(room.round === null, true);

  mock.timers.tick(config.countdownMs);
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.round?.number, 1);
});

test('a round that nobody solves reveals, then advances', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  mock.timers.tick(config.roundDurationMs);
  assert.equal(room.status, 'REVEALING');
  assert.equal(room.reveal?.scores.length, 0);

  mock.timers.tick(config.revealDurationMs);
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.round?.number, 2);
});

test('the game finishes after the configured number of rounds', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  for (let i = 0; i < config.rounds; i++) {
    assert.equal(room.status, 'PLAYING', `round ${i + 1} should be playing`);
    mock.timers.tick(config.roundDurationMs);
    mock.timers.tick(config.revealDurationMs);
  }

  assert.equal(room.status, 'FINISHED');
  assert.equal(room.round, null);
});

test('a correct guess scores, and the answer stays hidden until the reveal', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  const outcome = submitGuess(room, 'a', answer(room), broadcast);
  assert.deepEqual(outcome.ok && outcome.correct, true);
  assert.ok(room.players.get('a')!.score > 0);

  // Still mid-round: the client view must not contain the title.
  const view = publicState(room, 'b');
  assert.equal(view.reveal, null);
  assert.equal(JSON.stringify(view).includes(answer(room)), false);
});

test('a wrong guess scores nothing and does not tell the room', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  const before = broadcasts;
  const outcome = submitGuess(room, 'a', 'definitely not the song', broadcast);
  assert.deepEqual(outcome, { ok: true, correct: false, points: 0 });
  assert.equal(room.players.get('a')!.score, 0);
  assert.equal(broadcasts, before, 'a wrong guess must not broadcast');
});

test('the same player cannot bank a song twice', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  submitGuess(room, 'a', answer(room), broadcast);
  const score = room.players.get('a')!.score;

  const again = submitGuess(room, 'a', answer(room), broadcast);
  assert.equal(again.ok, false);
  assert.equal(room.players.get('a')!.score, score);
});

test('wrong guesses are rate limited', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  for (let i = 0; i < config.maxGuessesPerRound; i++) {
    assert.equal(submitGuess(room, 'a', `wrong ${i}`, broadcast).ok, true);
    mock.timers.tick(config.guessCooldownMs);
  }
  const blocked = submitGuess(room, 'a', 'wrong again', broadcast);
  assert.equal(blocked.ok, false);

  // ...and the limit resets with the next round.
  mock.timers.tick(config.roundDurationMs);
  mock.timers.tick(config.revealDurationMs);
  assert.equal(submitGuess(room, 'a', 'wrong once more', broadcast).ok, true);
});

test('the round ends early once everyone has solved it', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  const title = answer(room);
  submitGuess(room, 'a', title, broadcast);
  assert.equal(room.status, 'PLAYING', 'one of two is not everyone');

  submitGuess(room, 'b', title, broadcast);
  assert.equal(room.status, 'REVEALING');
  assert.equal(room.reveal?.scores.length, 2);
});

test('answering sooner beats answering later', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  const title = answer(room);
  submitGuess(room, 'a', title, broadcast);
  mock.timers.tick(5_000);
  submitGuess(room, 'b', title, broadcast);

  assert.ok(
    room.players.get('a')!.score > room.players.get('b')!.score,
    'the earlier guess should score higher',
  );
});

test('extending the clip lowers the score for the same answer', async () => {
  const roomA = twoPlayerRoom();
  await startGame(roomA, broadcast);
  mock.timers.tick(config.countdownMs);
  submitGuess(roomA, 'a', answer(roomA), broadcast);
  const withShortClip = roomA.players.get('a')!.score;

  resetRooms();
  const roomB = twoPlayerRoom();
  await startGame(roomB, broadcast);
  mock.timers.tick(config.countdownMs);
  assert.equal(extendClip(roomB, 'a', broadcast), null);
  submitGuess(roomB, 'a', answer(roomB), broadcast);
  const withLongerClip = roomB.players.get('a')!.score;

  assert.ok(
    withShortClip > withLongerClip,
    `${withShortClip} should beat ${withLongerClip}`,
  );
});

test('the clip cannot be extended past the longest configured duration', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  for (let i = 0; i < config.clipDurations.length - 1; i++) {
    assert.equal(extendClip(room, 'a', broadcast), null, `extension ${i + 1}`);
  }
  assert.match(extendClip(room, 'a', broadcast) ?? '', /whole clip/);

  const view = publicState(room, 'a').round!;
  assert.equal(view.canExtend, false);
  assert.equal(view.clipDuration, config.clipDurations.at(-1));
});

test('each player sees only their own clip length', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);
  extendClip(room, 'a', broadcast);

  assert.equal(publicState(room, 'a').round!.clipDuration, config.clipDurations[1]);
  assert.equal(publicState(room, 'b').round!.clipDuration, config.clipDurations[0]);
});

test('guesses outside a round are refused', async () => {
  const room = twoPlayerRoom();
  assert.equal(submitGuess(room, 'a', 'anything', broadcast).ok, false);

  await startGame(room, broadcast);
  assert.equal(submitGuess(room, 'a', 'anything', broadcast).ok, false, 'not during countdown');
});

test('a player leaving mid-game does not break the round', async () => {
  const room = twoPlayerRoom();
  addPlayer(room, player('c'));
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  submitGuess(room, 'a', answer(room), broadcast);
  removePlayer(room, 'b');

  assert.equal(room.status, 'PLAYING');
  // Now that only a and c remain and a has solved it, c solving ends the round.
  submitGuess(room, 'c', answer(room), broadcast);
  assert.equal(room.status, 'REVEALING');
});

test('stopping a game clears its timers', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  stopGame(room);

  const status = room.status;
  mock.timers.tick(config.countdownMs * 10);
  assert.equal(room.status, status, 'no timer should have fired');
  assert.equal(room.round, null);
});

test('each player gets their own clip ticket, unlocking exactly their length', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  const a = publicState(room, 'a').round!.clipToken!;
  const b = publicState(room, 'b').round!.clipToken!;
  assert.notEqual(a, b);
  assert.equal(redeemClip(a)?.duration, config.clipDurations[0]);

  extendClip(room, 'a', broadcast);
  const extended = publicState(room, 'a').round!.clipToken!;
  assert.notEqual(extended, a, 'hearing more issues a new ticket');
  assert.equal(redeemClip(extended)?.duration, config.clipDurations[1]);
  assert.equal(publicState(room, 'b').round!.clipToken, b, "b's ticket is untouched");
});

test('the reveal unlocks the longest clip for everyone', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);
  mock.timers.tick(config.roundDurationMs);

  const token = room.reveal!.clipToken!;
  assert.equal(redeemClip(token)?.duration, Math.max(...config.clipDurations));
});

test('round tickets stop working after the round', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);
  const token = publicState(room, 'a').round!.clipToken!;

  mock.timers.tick(config.roundDurationMs + 10_000);
  assert.equal(redeemClip(token), null);
});

test('a music server outage returns the room to the lobby with a message', async () => {
  const room = twoPlayerRoom();
  musicServerDown = true;

  const problem = await startGame(room, broadcast);
  assert.match(problem ?? '', /music server is down/i);
  assert.equal(room.status, 'LOBBY');

  // ...and the host can simply try again once it's back.
  musicServerDown = false;
  assert.equal(await startGame(room, broadcast), null);
  mock.timers.tick(config.countdownMs);
  assert.equal(room.status, 'PLAYING');
});

test('everyone leaving while songs load does not start a ghost game', async () => {
  const room = twoPlayerRoom();
  const starting = startGame(room, broadcast);
  removePlayer(room, 'a');
  removePlayer(room, 'b');
  await starting;

  mock.timers.tick(config.countdownMs * 10);
  assert.equal(room.round, null);
});

test("the game plays the host's chosen category", async () => {
  const room = twoPlayerRoom();
  room.categoryId = '2010s';
  await startGame(room, broadcast);
  assert.equal(requestedCategory, '2010s');
});

test('repeating the same wrong guess is ignored, not counted', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  assert.equal(submitGuess(room, 'a', 'Wrong Song', broadcast).ok, true);
  mock.timers.tick(config.guessCooldownMs);
  const repeat = submitGuess(room, 'a', '  wrong song! ', broadcast);
  assert.deepEqual(repeat, { ok: false, reason: 'You already tried that' });
  assert.equal(room.round!.attempts.get('a'), 1, 'the repeat used no attempt');
});

test('guesses faster than anyone can type are refused', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  assert.equal(submitGuess(room, 'a', 'one', broadcast).ok, true);
  assert.deepEqual(submitGuess(room, 'a', 'two', broadcast), { ok: false, reason: 'Slow down a little' });
  assert.equal(submitGuess(room, 'b', 'two', broadcast).ok, true, 'the cooldown is per player');

  mock.timers.tick(config.guessCooldownMs);
  assert.equal(submitGuess(room, 'a', 'two', broadcast).ok, true);
});

test('a dropped player does not hold up the round for everyone else', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  submitGuess(room, 'a', answer(room), broadcast);
  assert.equal(room.status, 'PLAYING', "b hasn't answered yet");

  setConnected(room, 'b', false);
  assert.equal(endIfEveryoneSolved(room, broadcast), true, 'everyone still online has it');
  assert.equal(room.status, 'REVEALING');
});

test('a player who drops and returns keeps their score', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);
  submitGuess(room, 'a', answer(room), broadcast);
  const score = room.players.get('a')!.score;

  setConnected(room, 'a', false);
  assert.deepEqual(addPlayer(room, player('a')), { ok: true }, 'rejoining mid-game is allowed');
  assert.equal(room.players.get('a')!.score, score);
  assert.equal(room.players.get('a')!.connected, true);
});

test('the countdown end time is published once songs are ready', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  assert.equal(publicState(room, 'a').countdownEndsAt, Date.now() + config.countdownMs);

  mock.timers.tick(config.countdownMs);
  assert.equal(publicState(room, 'a').countdownEndsAt, null);
});

test('a latecomer sits out the current round and plays the next', async () => {
  const room = twoPlayerRoom();
  await startGame(room, broadcast);
  mock.timers.tick(config.countdownMs);

  addPlayer(room, player('late'));
  assert.equal(publicState(room, 'late').round!.clipToken, null, 'no clip for a round they missed');
  assert.match(submitGuess(room, 'late', answer(room), broadcast).ok ? '' : 'refused', /refused/);
  assert.match(extendClip(room, 'late', broadcast) ?? '', /next round/);

  // The round still ends early once the original two have it.
  const title = answer(room);
  submitGuess(room, 'a', title, broadcast);
  submitGuess(room, 'b', title, broadcast);
  assert.equal(room.status, 'REVEALING', 'the latecomer does not hold the round open');

  mock.timers.tick(config.revealDurationMs);
  assert.ok(publicState(room, 'late').round!.clipToken, 'in from the next round');
  assert.equal(submitGuess(room, 'late', answer(room), broadcast).ok, true);
});
