import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../shared/config.ts';
import { parseClientMessage } from './protocol.ts';

test('clip durations increase, so later attempts are never harder', () => {
  const sorted = [...config.clipDurations].sort((a, b) => a - b);
  assert.deepEqual([...config.clipDurations], sorted);
  assert.ok(config.clipDurations.length > 0);
});

test('a game needs at least two players and a sane cap', () => {
  assert.ok(config.minPlayers >= 2);
  assert.ok(config.maxPlayers > config.minPlayers);
});

test('the protocol rejects junk', () => {
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('null'), null);
  assert.equal(parseClientMessage('{"type":"drop table"}'), null);
  assert.equal(parseClientMessage('x'.repeat(5000)), null);
  assert.equal(parseClientMessage(42), null);
});

test('join requires a room ID and tolerates missing credentials', () => {
  assert.equal(parseClientMessage('{"type":"join"}'), null);
  assert.equal(parseClientMessage('{"type":"join","roomId":""}'), null);
  assert.equal(parseClientMessage('{"type":"join","roomId":123}'), null);

  assert.deepEqual(parseClientMessage('{"type":"join","roomId":"c1"}'), {
    type: 'join',
    roomId: 'c1',
    accessToken: null,
    guestName: null,
    guestId: null,
  });
});

test('over-long credentials are dropped, not trusted or truncated', () => {
  const message = parseClientMessage(
    JSON.stringify({ type: 'join', roomId: 'c1', accessToken: 'x'.repeat(600) }),
  );
  // Dropping it to null means the server treats the join as a guest attempt,
  // which production rejects outright.
  assert.deepEqual(message, { type: 'join', roomId: 'c1', accessToken: null, guestName: null, guestId: null });
});

test('simple messages parse', () => {
  assert.deepEqual(parseClientMessage('{"type":"leave"}'), { type: 'leave' });
  assert.deepEqual(parseClientMessage('{"type":"startGame"}'), { type: 'startGame' });
});

test('setCategory needs a category ID', () => {
  assert.deepEqual(parseClientMessage('{"type":"setCategory","categoryId":"90s"}'), {
    type: 'setCategory',
    categoryId: '90s',
  });
  assert.equal(parseClientMessage('{"type":"setCategory"}'), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'setCategory', categoryId: 'x'.repeat(40) })), null);
});

test('search queries are length-capped', () => {
  assert.deepEqual(parseClientMessage('{"type":"search","query":"queen"}'), { type: 'search', query: 'queen' });
  assert.equal(parseClientMessage('{"type":"search","query":""}'), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'search', query: 'x'.repeat(61) })), null);
});

test('a guest ID must look like an ID, or it is ignored', () => {
  const join = (guestId: unknown) =>
    parseClientMessage(JSON.stringify({ type: 'join', roomId: 'c1', guestId }));
  assert.equal((join('3f2b1c9e-aaaa-4bbb-8ccc-1234567890ab') as { guestId: string }).guestId, '3f2b1c9e-aaaa-4bbb-8ccc-1234567890ab');
  for (const bad of [undefined, null, 12345678, 'short', 'has spaces in it', 'x'.repeat(65), '../../etc']) {
    assert.equal((join(bad) as { guestId: unknown }).guestId, null, String(bad));
  }
});
