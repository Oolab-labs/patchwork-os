/**
 * Resolver tests.
 *
 * The FactConsolidation cases below are the whole reason this is code and not
 * a prompt: on that benchmark, systems that hand consolidation to a model score
 * 7–18% even when the tie-break rule is stated in the prompt. These must hold
 * deterministically, forever, at zero token cost.
 */

import { describe, expect, it } from "vitest";
import { resolveFacts, resolveOne } from "../resolve.js";
import type { ButlerFact, ProvenanceChannel } from "../types.js";
import { PROVENANCE_TIER } from "../types.js";

let nextSeq = 1;

function fact(
  subject: string,
  predicate: string,
  object: string,
  o: {
    seq?: number;
    channel?: ProvenanceChannel;
    contentConfidence?: number;
    recordedAt?: number;
    validFrom?: number;
    validUntil?: number;
    retracts?: number;
    ownerId?: string | null;
  } = {},
): ButlerFact {
  const channel = o.channel ?? "user_chat";
  const tier = PROVENANCE_TIER[channel];
  const contentConfidence = o.contentConfidence ?? 1;
  const recordedAt = o.recordedAt ?? 1000;
  return {
    seq: o.seq ?? nextSeq++,
    ownerId: o.ownerId === undefined ? "u1" : o.ownerId,
    subject,
    predicate,
    object,
    recordedAt,
    validFrom: o.validFrom ?? recordedAt,
    ...(o.validUntil !== undefined && { validUntil: o.validUntil }),
    ...(o.retracts !== undefined && { retracts: o.retracts }),
    provenance: { channel, tier, validated: channel === "user_confirmed" },
    contentConfidence,
    trust: Math.min(tier, contentConfidence),
  };
}

const NOW = 10_000;
const at = { now: NOW, ownerId: "u1" } as const;

describe("FactConsolidation — contradictory rows", () => {
  it("later beats earlier at equal trust", () => {
    const facts = [
      fact("user", "city", "Berlin", { seq: 1 }),
      fact("user", "city", "Lisbon", { seq: 2 }),
    ];
    expect(resolveOne(facts, "user", "city", at)?.object).toBe("Lisbon");
  });

  it("is order-independent — shuffling the log cannot change the answer", () => {
    const a = fact("user", "city", "Berlin", { seq: 1 });
    const b = fact("user", "city", "Lisbon", { seq: 2 });
    const c = fact("user", "city", "Porto", { seq: 3 });
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, c, a],
      [c, a, b],
    ]) {
      expect(resolveOne(order, "user", "city", at)?.object).toBe("Porto");
    }
  });

  it("trust outranks recency — a newer low-trust claim loses", () => {
    const facts = [
      fact("user", "diet.avoid", "shellfish", { seq: 1, channel: "user_chat" }),
      // Arrived later, from an email. Must not win by being last.
      fact("user", "diet.avoid", "nothing", { seq: 99, channel: "connector" }),
    ];
    expect(resolveOne(facts, "user", "diet.avoid", at)?.object).toBe(
      "shellfish",
    );
  });

  it("keeps unrelated predicates independent", () => {
    const facts = [
      fact("user", "city", "Lisbon", { seq: 1 }),
      fact("user", "timezone", "WET", { seq: 2 }),
      fact("household.spouse", "city", "Berlin", { seq: 3 }),
    ];
    const all = resolveFacts(facts, at);
    expect(all).toHaveLength(3);
    expect(resolveOne(facts, "household.spouse", "city", at)?.object).toBe(
      "Berlin",
    );
  });
});

describe("retraction", () => {
  it("a tombstone removes the belief entirely", () => {
    const facts = [
      fact("user", "city", "Lisbon", { seq: 1 }),
      fact("user", "city", "", { seq: 2, retracts: 1 }),
    ];
    expect(resolveOne(facts, "user", "city", at)).toBeUndefined();
  });

  it("a tombstone can kill a maximum-trust row", () => {
    // Otherwise the user could never withdraw something they said outright.
    const facts = [
      fact("user", "city", "Lisbon", { seq: 1, channel: "user_confirmed" }),
      fact("user", "city", "", { seq: 2, retracts: 1, channel: "user_chat" }),
    ];
    expect(resolveOne(facts, "user", "city", at)).toBeUndefined();
  });

  it("a tombstone is never itself a belief", () => {
    const facts = [fact("user", "city", "ignored", { seq: 1, retracts: 999 })];
    expect(resolveFacts(facts, at)).toEqual([]);
  });
});

describe("validity window", () => {
  it("ignores a fact that has not started yet", () => {
    const facts = [
      fact("user", "city", "Tokyo", { seq: 1, validFrom: NOW + 1 }),
    ];
    expect(resolveOne(facts, "user", "city", at)).toBeUndefined();
  });

  it("ignores an expired fact and falls back to what remains", () => {
    const facts = [
      fact("user", "city", "Berlin", { seq: 1 }),
      fact("user", "city", "Lisbon", { seq: 2, validUntil: NOW - 1 }),
    ];
    expect(resolveOne(facts, "user", "city", at)?.object).toBe("Berlin");
  });
});

describe("poisoning floor", () => {
  it("connector text alone cannot establish a belief above the floor", () => {
    // The ASI06 shape: an email says something authoritative. It is recorded —
    // suppressing it would lose the audit trail — but it never rises to a
    // belief at the originate threshold.
    const facts = [
      fact("user", "diet.avoid", "nothing at all", {
        seq: 1,
        channel: "connector",
      }),
    ];
    expect(resolveFacts(facts, { ...at, minTrust: 0.6 })).toEqual([]);
    // Visible when explicitly asking for everything.
    expect(resolveFacts(facts, at)).toHaveLength(1);
  });

  it("volume does not defeat the tier ceiling", () => {
    const flood = Array.from({ length: 50 }, (_, i) =>
      fact("user", "city", "Attackerville", {
        seq: 100 + i,
        channel: "connector",
      }),
    );
    const facts = [fact("user", "city", "Lisbon", { seq: 1 }), ...flood];
    expect(resolveOne(facts, "user", "city", at)?.object).toBe("Lisbon");
    expect(
      resolveOne(facts, "user", "city", { ...at, minTrust: 0.6 })?.object,
    ).toBe("Lisbon");
  });

  it("hedged wording lowers trust below an unhedged claim", () => {
    const facts = [
      fact("user", "city", "Lisbon", { seq: 1, contentConfidence: 1 }),
      fact("user", "city", "Madrid", { seq: 2, contentConfidence: 0.4 }),
    ];
    expect(resolveOne(facts, "user", "city", at)?.object).toBe("Lisbon");
  });
});

describe("owner scoping", () => {
  it("never leaks another owner's belief", () => {
    const facts = [
      fact("user", "city", "Lisbon", { seq: 1, ownerId: "u1" }),
      fact("user", "city", "Oslo", { seq: 2, ownerId: "u2" }),
    ];
    expect(resolveOne(facts, "user", "city", at)?.object).toBe("Lisbon");
    expect(
      resolveOne(facts, "user", "city", { now: NOW, ownerId: "u2" })?.object,
    ).toBe("Oslo");
  });

  it("treats unattributed rows as their own scope, not everyone's", () => {
    // ownerId null means "nobody recorded who this was about". It must not
    // silently become the current user's belief.
    const facts = [
      fact("user", "city", "Nowhere", { seq: 1, ownerId: null }),
      fact("user", "city", "Lisbon", { seq: 2, ownerId: "u1" }),
    ];
    expect(resolveOne(facts, "user", "city", at)?.object).toBe("Lisbon");
    expect(
      resolveOne(facts, "user", "city", { now: NOW, ownerId: null })?.object,
    ).toBe("Nowhere");
  });
});

describe("purity", () => {
  it("does not mutate or reorder its input", () => {
    const facts = [
      fact("user", "city", "Berlin", { seq: 2 }),
      fact("user", "city", "Lisbon", { seq: 1 }),
    ];
    const before = JSON.parse(JSON.stringify(facts));
    resolveFacts(facts, at);
    expect(facts).toEqual(before);
  });

  it("is stable across repeated calls", () => {
    const facts = [
      fact("user", "b", "2", { seq: 1 }),
      fact("user", "a", "1", { seq: 2 }),
    ];
    expect(resolveFacts(facts, at)).toEqual(resolveFacts(facts, at));
    expect(resolveFacts(facts, at).map((f) => f.predicate)).toEqual(["a", "b"]);
  });
});
