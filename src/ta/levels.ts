/**
 * Range-thirds price levels.
 *
 * From a swing-low → swing-high range R, the ladder is `low + k·(R/3)` for
 * k = 0..maxK. k=0 is the low, k=3 is the high ("full cycle"), and k=4
 * (`high + R/3`) is the level the method claims tops ~78% of the time. The 50%
 * retracement is tracked separately because the method uses it as its own
 * support/resistance, distinct from the thirds ladder.
 *
 * The 137 / fine-structure-constant levels from the source material are
 * deliberately NOT implemented — pure numerology, no mechanism.
 */

import type { PriceLevels } from "./types.js";

/** Static annotation of the source material's claimed fourth-level top rate. */
export const FOURTH_LEVEL_TOP_HINT = 0.78;

/**
 * Compute levels for a swing-low → swing-high range. Returns null when the
 * range is non-positive (caller picked a high at/below the low — the method
 * always measures low → high, so that input is meaningless).
 */
export function computeLevels(
  swingLow: number,
  swingHigh: number,
  maxK = 9,
): PriceLevels | null {
  const range = swingHigh - swingLow;
  if (!(range > 0) || !Number.isFinite(range)) return null;
  if (maxK < 3)
    throw new Error(`maxK must be >= 3 (to reach the high), got ${maxK}`);

  const step = range / 3;
  const ladder: { k: number; price: number }[] = [];
  for (let k = 0; k <= maxK; k++) {
    ladder.push({ k, price: swingLow + k * step });
  }

  return {
    swingLow,
    swingHigh,
    range,
    fifty: swingLow + range / 2,
    ladder,
    fourthLevel: maxK >= 4 ? swingLow + 4 * step : null,
    fourthLevelTopProbabilityHint: FOURTH_LEVEL_TOP_HINT,
  };
}
