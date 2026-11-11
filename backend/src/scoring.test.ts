import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../shared/config.ts';
import { maxRoundScore, scoreGuess, SCORING } from './scoring.ts';

const lastLevel = config.clipDurations.length - 1;

test('an instant answer on the shortest clip scores the maximum', () => {
  const points = scoreGuess({
    elapsedMs: 0,
    roundDurationMs: config.roundDurationMs,
    clipLevel: 0,
  });
  assert.equal(points, maxRoundScore);
});

test('a last-second answer on the longest clip scores only the base', () => {
  const points = scoreGuess({
    elapsedMs: config.roundDurationMs,
    roundDurationMs: config.roundDurationMs,
    clipLevel: lastLevel,
  });
  assert.equal(points, SCORING.base);
});

test('faster is always worth more, all else equal', () => {
  const fast = scoreGuess({ elapsedMs: 1_000, roundDurationMs: 30_000, clipLevel: 0 });
  const slow = scoreGuess({ elapsedMs: 20_000, roundDurationMs: 30_000, clipLevel: 0 });
  assert.ok(fast > slow, `${fast} should beat ${slow}`);
});

test('a shorter clip is always worth more, all else equal', () => {
  const short = scoreGuess({ elapsedMs: 5_000, roundDurationMs: 30_000, clipLevel: 0 });
  const long = scoreGuess({ elapsedMs: 5_000, roundDurationMs: 30_000, clipLevel: lastLevel });
  assert.ok(short > long, `${short} should beat ${long}`);
});

test('scores never fall below the base or exceed the maximum', () => {
  // Overrun clock and out-of-range clip level must not produce nonsense.
  const overrun = scoreGuess({ elapsedMs: 99_000, roundDurationMs: 30_000, clipLevel: 99 });
  assert.equal(overrun, SCORING.base);

  const negative = scoreGuess({ elapsedMs: -5_000, roundDurationMs: 30_000, clipLevel: -3 });
  assert.equal(negative, maxRoundScore);
});

test('a zero-length round does not divide by zero', () => {
  const points = scoreGuess({ elapsedMs: 0, roundDurationMs: 0, clipLevel: 0 });
  assert.ok(Number.isFinite(points));
});

test('every score is a whole number', () => {
  for (let elapsed = 0; elapsed <= 30_000; elapsed += 2_500) {
    for (let level = 0; level <= lastLevel; level++) {
      const points = scoreGuess({ elapsedMs: elapsed, roundDurationMs: 30_000, clipLevel: level });
      assert.equal(Number.isInteger(points), true, `${elapsed}ms level ${level} -> ${points}`);
    }
  }
});
