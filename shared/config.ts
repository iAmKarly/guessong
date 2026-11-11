/**
 * Every tunable number in the game lives here so nothing gets hard-coded
 * across modules. Changing a value here changes it everywhere.
 */
export const config = {
  /** Rounds in a full game. */
  rounds: 10,

  /**
   * Playable clip length per attempt, in seconds. The audio *segment* stays
   * fixed for the round; only how much of it you may hear grows.
   */
  clipDurations: [0.1, 0.5, 1, 2, 5],

  minPlayers: 2,
  maxPlayers: 12,

  /** Pause on the countdown before the first round, in ms. */
  countdownMs: 3_000,
  /** How long players get to guess once a round starts, in ms. */
  roundDurationMs: 30_000,
  /** How long the answer stays on screen before the next round, in ms. */
  revealDurationMs: 6_000,
  /** Wrong guesses allowed per player per round, before we stop listening. */
  maxGuessesPerRound: 8,
  /** Minimum gap between one player's guesses, in ms. Faster than anyone types. */
  guessCooldownMs: 300,
  /**
   * How long a dropped player keeps their seat and score, in ms. Covers a
   * refresh or a wobbly connection; after this they're removed from the room.
   */
  reconnectGraceMs: 30_000,

  /**
   * What the host can choose to play. The first is the default. How each one
   * finds its songs is up to the audio provider (see backend/src/deezer.ts).
   */
  categories: [
    { id: 'top', label: 'Top hits right now' },
    { id: '2020s', label: '2020s' },
    { id: '2010s', label: '2010s' },
    { id: '2000s', label: '2000s' },
    { id: '90s', label: '90s' },
    { id: '80s', label: '80s' },
    { id: 'pop', label: 'Pop' },
    { id: 'rock', label: 'Rock' },
    { id: 'hiphop', label: 'Hip-hop' },
    { id: 'dance', label: 'Dance' },
  ],
} as const;

export type Config = typeof config;
