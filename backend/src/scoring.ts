import { config } from '../../shared/config.ts';

/**
 * Points for a correct guess. Pure and deterministic so it can be reasoned
 * about and tested — no clocks, no randomness, no I/O.
 *
 * Three things earn points, in the spirit of the game:
 *   1. being right at all
 *   2. being fast
 *   3. needing less of the clip
 *
 * Keep this module the only place the formula lives, so tuning it is a one-file
 * change.
 */

export const SCORING = {
  /** Awarded for any correct answer. */
  base: 200,
  /** Maximum additional points for answering instantly. */
  speed: 300,
  /** Maximum additional points for solving it on the shortest clip. */
  brevity: 200,
} as const;

export type ScoreInput = {
  /** Time from round start to the correct guess, in ms. */
  elapsedMs: number;
  /** Total time allowed for the round, in ms. */
  roundDurationMs: number;
  /** Index into config.clipDurations that the player had reached. */
  clipLevel: number;
};

export function scoreGuess({ elapsedMs, roundDurationMs, clipLevel }: ScoreInput): number {
  const remaining = clamp01(1 - elapsedMs / roundDurationMs);

  const levels = config.clipDurations.length;
  // With a single configured clip length there is no brevity to reward.
  const brevityFraction = levels > 1 ? 1 - clamp01(clipLevel / (levels - 1)) : 1;

  return Math.round(
    SCORING.base + SCORING.speed * remaining + SCORING.brevity * brevityFraction,
  );
}

/** Highest possible score for a single round — handy for tests and UI copy. */
export const maxRoundScore = SCORING.base + SCORING.speed + SCORING.brevity;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
