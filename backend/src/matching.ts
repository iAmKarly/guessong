/**
 * Guess matching: normalise both sides, then allow a few typos.
 *
 * Isolated so it can be replaced wholesale without touching the game engine.
 *
 * ponytail: normalisation plus edit distance. No phonetic matching, no LLM.
 * Add those only if real games show people losing to things this misses.
 */

/** Combining diacritical marks, left over after NFKD decomposition. */
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Reduce an answer to its comparable core, so these all match:
 *   "Blinding Lights", "blinding lights", "The Weeknd - Blinding Lights"
 */
export function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(DIACRITICS, '')
      // Bracketed noise: "(Remastered)", "[Official Video]", "(feat. X)".
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      // Apostrophes vanish rather than splitting a word: don't -> dont.
      .replace(/['ʼ’`]/g, '')
      .replace(/&/g, ' and ')
      // Anything else that isn't a letter, number, or space becomes a gap. This
      // turns "artist - title" into "artist title", which is why a guess never
      // has text after a dash stripped: players type that form far more often
      // than "title - Radio Edit". Song titles get that treatment instead; see
      // `names` below.
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      // Unbracketed featured artists: "song feat someone" -> "song".
      .replace(/\s(feat|ft|featuring)\s.*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Words that carry no identifying weight. Dropped wherever they appear, not
 * just at the start, so "Blinding Lights The Weeknd" and "the weeknd blinding
 * lights" reduce to the same thing. Applied to both sides of every comparison,
 * so removing them can't create a false match.
 */
const FILLER = /\b(the|a|an)\b/g;

function core(text: string): string {
  const stripped = normalize(text).replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  // A title made entirely of filler ("The The") would otherwise vanish.
  return stripped.length > 0 ? stripped : normalize(text);
}

/**
 * A title as a person would say it: no "- Remastered 2011", no "(feat. X)".
 * Used for autocomplete, so versions of one song collapse into one entry.
 */
export function plainTitle(title: string): string {
  return title
    .split(/\s[-–—]\s/)[0]!
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, '')
    .trim();
}

/**
 * Every name a song answers to. Catalogs append versions after a dash —
 * "Bohemian Rhapsody - Remastered 2011", "Levitating - Radio Edit" — which
 * nobody types, so the part before the dash counts too.
 */
function names(song: { title: string; aliases?: readonly string[] }): string[] {
  return [song.title, ...(song.aliases ?? [])].flatMap((name) => {
    const beforeDash = name.split(/\s[-–—]\s/)[0]!;
    return beforeDash !== name ? [name, beforeDash] : [name];
  });
}

/**
 * Typos forgiven for an answer of this many characters. Short titles must be
 * exact, or "slay" would count for "Stay".
 */
export function allowedTypos(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  if (length <= 15) return 2;
  return 3;
}

/**
 * Edits needed to turn `a` into `b`: insertions, deletions, substitutions and
 * swaps of neighbouring letters ("teh" -> "the" is one edit, not two).
 */
export function editDistance(a: string, b: string): number {
  // rows[i][j] = distance between the first i chars of a and first j of b.
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        rows[i - 1]![j]! + 1, // delete
        rows[i]![j - 1]! + 1, // insert
        rows[i - 1]![j - 1]! + substitution, // substitute (or match)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1); // swap neighbours
      }
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

function closeEnough(guess: string, answer: string): boolean {
  // Cheap check first: lengths alone can rule a match out.
  const typos = allowedTypos(answer.length);
  if (Math.abs(guess.length - answer.length) > typos) return false;
  return guess === answer || editDistance(guess, answer) <= typos;
}

/**
 * Whether a guess names the song: the title or any alias, optionally with the
 * artist in either order, with a few typos forgiven.
 */
export function isCorrect(
  guess: string,
  song: { title: string; artist: string; aliases?: readonly string[] },
): boolean {
  // Guesses are capped at 200 characters by the protocol, which keeps the
  // edit-distance table small.
  const guessed = core(guess);
  if (guessed.length === 0) return false;

  const artist = core(song.artist);
  return names(song).some((name) => {
    const title = core(name);
    return [title, `${artist} ${title}`, `${title} ${artist}`].some((answer) =>
      closeEnough(guessed, answer),
    );
  });
}
