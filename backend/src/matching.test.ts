import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allowedTypos, editDistance, isCorrect, normalize } from './matching.ts';

const song = { title: 'Blinding Lights', artist: 'The Weeknd' };

test('normalize flattens case, punctuation and whitespace', () => {
  assert.equal(normalize('  Blinding   LIGHTS!! '), 'blinding lights');
  assert.equal(normalize("Don't Stop Me Now"), 'dont stop me now');
  assert.equal(normalize('Me & You'), 'me and you');
});

test('normalize strips accents', () => {
  assert.equal(normalize('Björk'), 'bjork');
  assert.equal(normalize('Beyoncé'), 'beyonce');
});

test('normalize drops bracketed noise and treats dashes as gaps', () => {
  assert.equal(normalize('Bohemian Rhapsody (Remastered 2011)'), 'bohemian rhapsody');
  assert.equal(normalize('Song Title [Official Video]'), 'song title');
  // Not "levitating" — see the comment in normalize about "artist - title".
  assert.equal(normalize('Levitating - Radio Edit'), 'levitating radio edit');
});

test('accepts the title in any casing or spacing', () => {
  for (const guess of ['Blinding Lights', 'blinding lights', '  BLINDING   lights!  ']) {
    assert.ok(isCorrect(guess, song), guess);
  }
});

test('accepts the artist alongside the title, in either order', () => {
  assert.ok(isCorrect('the weeknd - blinding lights', song));
  assert.ok(isCorrect('The Weeknd Blinding Lights', song));
  assert.ok(isCorrect('Blinding Lights The Weeknd', song));
});

test('ignores a leading article', () => {
  assert.ok(isCorrect('weeknd blinding lights', song));
  assert.ok(isCorrect('Less Than Zero', { title: 'The Less Than Zero', artist: 'x' }));
});

test('rejects wrong, empty and partial answers', () => {
  assert.equal(isCorrect('', song), false);
  assert.equal(isCorrect('   ', song), false);
  assert.equal(isCorrect('blinding', song), false);
  assert.equal(isCorrect('the weeknd', song), false);
  assert.equal(isCorrect('save your tears', song), false);
});

// --- Milestone 6: real catalog titles and typos ------------------------------

test('edit distance counts insertions, deletions, substitutions and swaps', () => {
  assert.equal(editDistance('lights', 'lights'), 0);
  assert.equal(editDistance('lights', 'light'), 1);
  assert.equal(editDistance('lights', 'lighta'), 1);
  assert.equal(editDistance('teh', 'the'), 1, 'a swap is one edit');
  assert.equal(editDistance('', 'abc'), 3);
});

test('a few typos are forgiven, scaled to the length of the title', () => {
  assert.ok(isCorrect('blindng lights', song), 'missing letter');
  assert.ok(isCorrect('blinidng lights', song), 'swapped letters');
  assert.ok(isCorrect('bohemian rapsody', { title: 'Bohemian Rhapsody', artist: 'Queen' }));
  assert.ok(isCorrect('levitatng', { title: 'Levitating', artist: 'Dua Lipa' }));
});

test('short titles must be exact, so similar words do not count', () => {
  const stay = { title: 'Stay', artist: 'x' };
  assert.ok(isCorrect('stay', stay));
  assert.equal(isCorrect('slay', stay), false);
  assert.equal(isCorrect('stays', stay), false);
});

test('too many typos are still wrong', () => {
  assert.equal(isCorrect('blnding lghts', song), true, 'two typos in 15 characters is fine');
  assert.equal(isCorrect('blndng lghts', song), false, 'three is not');
  assert.equal(isCorrect('flashing lights', song), false);
});

test('allowed typos grow with length', () => {
  assert.deepEqual([3, 4, 5, 8, 9, 15, 16, 40].map(allowedTypos), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('catalog version suffixes after a dash are optional', () => {
  const remaster = { title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen' };
  assert.ok(isCorrect('bohemian rhapsody', remaster));
  assert.ok(isCorrect('Bohemian Rhapsody - Remastered 2011', remaster), 'the full title still works');
  assert.ok(isCorrect('queen - bohemian rhapsody', remaster), 'artist - title still works');
  assert.ok(isCorrect('levitating', { title: 'Levitating – Radio Edit', artist: 'Dua Lipa' }), 'en dash');
});

test('featured artists are optional, bracketed or not', () => {
  const feat = { title: 'Señorita (feat. Someone)', artist: 'Shawn Mendes' };
  assert.ok(isCorrect('senorita', feat));
  assert.ok(isCorrect('Something feat. Someone Else', { title: 'Something', artist: 'x' }));
  assert.ok(isCorrect('Something ft Someone', { title: 'Something', artist: 'x' }));
});

test('curly apostrophes match straight ones', () => {
  assert.ok(isCorrect("don't stop me now", { title: 'Don’t Stop Me Now', artist: 'Queen' }));
});

test('a typo in the artist is forgiven too', () => {
  assert.ok(isCorrect('the wekend blinding lights', song));
});
