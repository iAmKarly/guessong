import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../shared/config.ts';
import type { Player } from '../../shared/types.ts';
import {
  addPlayer,
  getRoom,
  publicState,
  removePlayer,
  resetRooms,
  roomCount,
  setCategory,
  setConnected,
  startBlockedReason,
} from './rooms.ts';

const player = (id: string): Player => ({ id, name: id, avatarUrl: null, score: 0, connected: true });

beforeEach(resetRooms);

test('the first player to join becomes host', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  addPlayer(room, player('b'));
  assert.equal(room.hostId, 'a');
});

test('host leaving promotes the earliest remaining player', () => {
  const room = getRoom('c1');
  for (const id of ['a', 'b', 'c']) addPlayer(room, player(id));

  removePlayer(room, 'a');
  assert.equal(room.hostId, 'b');

  // A non-host leaving must not disturb the host.
  removePlayer(room, 'c');
  assert.equal(room.hostId, 'b');
});

test('an emptied room is discarded', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  assert.equal(roomCount(), 1);

  removePlayer(room, 'a');
  assert.equal(roomCount(), 0);
});

test('rejoining replaces the player instead of duplicating them', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  addPlayer(room, { ...player('a'), name: 'Renamed' });

  assert.equal(room.players.size, 1);
  assert.equal(room.players.get('a')?.name, 'Renamed');
  assert.equal(room.hostId, 'a');
});

test('a full lobby rejects newcomers but still admits existing players', () => {
  const room = getRoom('c1');
  for (let i = 0; i < config.maxPlayers; i++) {
    assert.deepEqual(addPlayer(room, player(`p${i}`)), { ok: true });
  }

  const full = addPlayer(room, player('extra'));
  assert.equal(full.ok, false);
  assert.equal(room.players.size, config.maxPlayers);

  // Someone already in the room reconnecting must not be turned away.
  assert.deepEqual(addPlayer(room, player('p0')), { ok: true });
});

test('players can join a game in progress, and returning players keep their place', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  room.status = 'PLAYING';

  assert.deepEqual(addPlayer(room, player('b')), { ok: true });
  assert.deepEqual(addPlayer(room, player('a')), { ok: true });
  assert.equal(room.players.size, 2);
});

test('only the host can start, and only with enough players', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));

  assert.match(startBlockedReason(room, 'a') ?? '', /at least/);

  addPlayer(room, player('b'));
  assert.equal(startBlockedReason(room, 'a'), null);
  assert.match(startBlockedReason(room, 'b') ?? '', /host/);

  room.status = 'PLAYING';
  assert.match(startBlockedReason(room, 'a') ?? '', /already running/);
});

test('public state tells each client which player it is', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  addPlayer(room, player('b'));

  const state = publicState(room, 'b');
  assert.equal(state.youId, 'b');
  assert.equal(state.hostId, 'a');
  assert.deepEqual(
    state.players.map((p) => p.id),
    ['a', 'b'],
  );
});

test('only the host can change the category, and only to a real one', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  addPlayer(room, player('b'));
  assert.equal(room.categoryId, config.categories[0].id, 'starts on the default');

  assert.match(setCategory(room, 'b', '2000s') ?? '', /host/);
  assert.match(setCategory(room, 'a', 'polka') ?? '', /unknown/i);
  assert.equal(setCategory(room, 'a', '2000s'), null);
  assert.equal(publicState(room, 'b').categoryId, '2000s');
});

test('the category is locked while a game runs, and free again after', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  room.status = 'PLAYING';
  assert.match(setCategory(room, 'a', 'rock') ?? '', /finish/);

  room.status = 'FINISHED';
  assert.equal(setCategory(room, 'a', 'rock'), null);
});

test('dropped players keep their seat but do not count towards starting', () => {
  const room = getRoom('c1');
  addPlayer(room, player('a'));
  addPlayer(room, player('b'));
  assert.equal(startBlockedReason(room, 'a'), null);

  setConnected(room, 'b', false);
  assert.equal(room.players.size, 2, 'b keeps their seat');
  assert.match(startBlockedReason(room, 'a') ?? '', /at least/);
  assert.equal(publicState(room, 'a').players.find((p) => p.id === 'b')!.connected, false);
});
