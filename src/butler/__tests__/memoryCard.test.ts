import { describe, expect, it } from "vitest";
import {
  buildMemoryCard,
  MAX_CARD_BYTES,
  MAX_FACT_CHARS,
} from "../memoryCard.js";
import type { ButlerFact, ProvenanceChannel } from "../types.js";
import { PROVENANCE_TIER } from "../types.js";

const NOW = 1_000 * 86_400_000; // day 1000

function fact(
  subject: string,
  predicate: string,
  object: string,
  o: { channel?: ProvenanceChannel; daysAgo?: number; seq?: number } = {},
): ButlerFact {
  const channel = o.channel ?? "user_chat";
  const tier = PROVENANCE_TIER[channel];
  const recordedAt = NOW - (o.daysAgo ?? 0) * 86_400_000;
  return {
    seq: o.seq ?? 1,
    ownerId: "u1",
    subject,
    predicate,
    object,
    recordedAt,
    validFrom: recordedAt,
    provenance: { channel, tier, validated: false },
    contentConfidence: 1,
    trust: tier,
  };
}

const opts = { now: NOW };

describe("content", () => {
  it("renders each belief with its age", () => {
    const card = buildMemoryCard(
      [fact("user", "diet.avoid", "shellfish", { daysAgo: 3 })],
      opts,
    );
    expect(card[0]).toMatch(/WHAT YOU KNOW/);
    expect(card[1]).toBe("  • user diet.avoid: shellfish (3d ago)");
  });

  it("says nothing at all when there is nothing to say", () => {
    // An empty heading with no content is worse than omitting the section.
    expect(buildMemoryCard([], opts)).toEqual([]);
  });

  it("shows age coarsely across scales", () => {
    const f = (d: number) =>
      buildMemoryCard([fact("u", "p", "v", { daysAgo: d })], opts)[1];
    expect(f(0)).toMatch(/today/);
    expect(f(1)).toMatch(/1d ago/);
    expect(f(10)).toMatch(/10d ago/);
    expect(f(90)).toMatch(/3mo ago/);
    expect(f(800)).toMatch(/2y ago/);
  });

  it("renders age so a stale belief is visibly stale", () => {
    // Agents do not self-detect staleness; the model can only weigh what it
    // can see.
    const card = buildMemoryCard(
      [fact("user", "employer", "Acme", { daysAgo: 500 })],
      opts,
    );
    expect(card[1]).toMatch(/16mo ago/);
  });
});

describe("trust floor", () => {
  it("excludes connector-derived claims by default", () => {
    // Anything Butler READ is attacker-controlled. Putting it in the system
    // prompt is the ASI06 attack in one step.
    const card = buildMemoryCard(
      [
        fact("user", "diet.avoid", "nothing", { channel: "connector" }),
        fact("user", "city", "Lisbon", { channel: "user_chat" }),
      ],
      opts,
    );
    expect(card.join("\n")).toContain("Lisbon");
    expect(card.join("\n")).not.toContain("nothing");
  });

  it("excludes an agent-written claim below the originate threshold", () => {
    const hedged = fact("user", "city", "Madrid", { channel: "recipe_agent" });
    hedged.trust = 0.4;
    expect(buildMemoryCard([hedged], opts)).toEqual([]);
  });

  it("emits nothing when every fact is below the floor", () => {
    const card = buildMemoryCard(
      [fact("user", "x", "y", { channel: "connector" })],
      opts,
    );
    expect(card).toEqual([]);
  });
});

describe("budget", () => {
  it("stays inside the byte cap", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      fact(`subject.${i}`, "predicate.long.name", "a".repeat(60), { seq: i }),
    );
    const card = buildMemoryCard(many, opts);
    expect(Buffer.byteLength(card.join("\n"), "utf8")).toBeLessThanOrEqual(
      MAX_CARD_BYTES,
    );
  });

  it("states how many it dropped rather than hiding the loss", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      fact(`s${i}`, "p", "v", { seq: i }),
    );
    const card = buildMemoryCard(many, opts);
    expect(card.join("\n")).toMatch(/\d+ more not shown/);
  });

  it("truncates a long fact instead of blowing the line budget", () => {
    const card = buildMemoryCard([fact("user", "note", "x".repeat(500))], opts);
    // The FACT body is capped; the "  • " prefix and " (age)" suffix are
    // bounded additions on top of it.
    const body = card[1]?.replace(/^ {2}• /, "").replace(/ \([^)]*\)$/, "");
    expect(body?.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    expect(card[1]).toMatch(/…/);
  });

  it("keeps the newest facts when the budget bites", () => {
    const card = buildMemoryCard(
      [
        fact("old", "p", "v", { daysAgo: 100, seq: 1 }),
        fact("new", "p", "v", { daysAgo: 0, seq: 2 }),
      ],
      { ...opts, maxFacts: 1 },
    );
    expect(card.join("\n")).toContain("new");
    expect(card.join("\n")).not.toContain("old p");
  });

  it("emits nothing rather than a bare heading when the cap is tiny", () => {
    const card = buildMemoryCard([fact("user", "city", "Lisbon")], {
      ...opts,
      maxBytes: 10,
    });
    expect(card).toEqual([]);
  });
});

describe("instructions", () => {
  it("tells the model not to parrot the facts back", () => {
    const card = buildMemoryCard([fact("user", "city", "Lisbon")], opts);
    expect(card.at(-1)).toMatch(/Do not restate/);
  });
});
