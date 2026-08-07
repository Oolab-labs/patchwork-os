/**
 * The trust tiers make a specific safety claim: an agent may REINFORCE a
 * belief the user has stated, but may not ORIGINATE one on its own. That claim
 * is only true if the agent tier sits strictly below the originate threshold.
 *
 * It did not. `recipe_agent` was 0.6, `ORIGINATE_THRESHOLD` was 0.6, and both
 * gates compare with `>=` — so an agent whose context was a just-read email
 * could seed a brand-new belief that rendered into every later session's
 * system prompt. The docstring asserting otherwise shipped in the same commit.
 */

import { describe, expect, it } from "vitest";
import { buildMemoryCard } from "../memoryCard.js";
import type { ButlerFact } from "../types.js";
import { ORIGINATE_THRESHOLD, PROVENANCE_TIER } from "../types.js";

const NOW = 1_000 * 86_400_000;

function factAt(trust: number): ButlerFact {
  return {
    seq: 1,
    ownerId: null,
    subject: "user",
    predicate: "diet.avoid",
    object: "nothing at all",
    recordedAt: NOW,
    validFrom: NOW,
    provenance: { channel: "recipe_agent", tier: trust, validated: false },
    contentConfidence: 1,
    trust,
  };
}

describe("only the user can originate a belief", () => {
  it("puts the agent tier strictly below the originate threshold", () => {
    expect(PROVENANCE_TIER.recipe_agent).toBeLessThan(ORIGINATE_THRESHOLD);
  });

  it("keeps connector text below it too, by a wider margin", () => {
    expect(PROVENANCE_TIER.connector).toBeLessThan(
      PROVENANCE_TIER.recipe_agent,
    );
  });

  it("lets the user tiers clear it", () => {
    expect(PROVENANCE_TIER.user_chat).toBeGreaterThanOrEqual(
      ORIGINATE_THRESHOLD,
    );
    expect(PROVENANCE_TIER.user_confirmed).toBeGreaterThanOrEqual(
      ORIGINATE_THRESHOLD,
    );
  });

  it("keeps an agent-written fact out of the system prompt", () => {
    // The end-to-end consequence: an agent that has just read a poisoned
    // email cannot put words in the next session's instructions block.
    const card = buildMemoryCard([factAt(PROVENANCE_TIER.recipe_agent)], {
      now: NOW,
    });
    expect(card).toEqual([]);
  });
});
