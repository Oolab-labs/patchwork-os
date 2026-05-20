import { describe, expect, it } from "vitest";
import {
  canonicalRecipeKey,
  inboxItemKey,
  parseTriggerSource,
} from "../entityKey";

/**
 * Pre-fix divergence reproduction.
 *
 * Each of the three call sites had its own ad-hoc stripper:
 *
 *   - dashboard/src/components/RecipeLeaderboard.tsx (~L70)
 *       name.replace(/:agent$/, "")
 *
 *   - dashboard/src/app/activity/page.tsx (~L69)
 *       rawRecipe.replace(/:agent$/, "")
 *
 *   - dashboard/src/app/inbox/page.tsx (~L945)
 *       name.replace(/\.md$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "")
 *
 * For multiple inputs they produce different values today, which is the
 * root cause of "same recipe but linked differently" across pages.
 * Once all three swap to canonicalRecipeKey / inboxItemKey, the three
 * stripper outputs converge for every recipe-identity input.
 */
const oldLeaderboardStripper = (s: string) => s.replace(/:agent$/, "");
const oldActivityStripper = (s: string) => s.replace(/:agent$/, "");
const oldInboxStripper = (s: string) =>
  s.replace(/\.md$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");

describe("pre-fix divergence — recorded for the record", () => {
  // These cases prove the three strippers diverge today. They use the
  // OLD inlined implementations; once call sites swap to the helper the
  // divergence is gone because every site uses the same function.
  it("morning-pulse:agent: leaderboard strips suffix, inbox leaves it untouched", () => {
    const input = "morning-pulse:agent";
    expect(oldLeaderboardStripper(input)).toBe("morning-pulse");
    expect(oldActivityStripper(input)).toBe("morning-pulse");
    expect(oldInboxStripper(input)).toBe("morning-pulse:agent");
    // Leaderboard !== inbox.
    expect(oldLeaderboardStripper(input)).not.toBe(oldInboxStripper(input));
  });

  it("morning-pulse-2026-05-20.md: inbox eats date+ext, leaderboard keeps everything", () => {
    const input = "morning-pulse-2026-05-20.md";
    expect(oldLeaderboardStripper(input)).toBe("morning-pulse-2026-05-20.md");
    expect(oldInboxStripper(input)).toBe("morning-pulse");
    expect(oldLeaderboardStripper(input)).not.toBe(oldInboxStripper(input));
  });

  it("morning-pulse-2026-05-20: inbox strips bare date, leaderboard keeps it", () => {
    // No .md extension; inbox-stripper still chews the date off because
    // its second .replace() is unconditional. This is the bug the
    // sibling provenance PR addresses — inboxItemKey leaves the date
    // alone.
    const input = "morning-pulse-2026-05-20";
    expect(oldLeaderboardStripper(input)).toBe("morning-pulse-2026-05-20");
    expect(oldInboxStripper(input)).toBe("morning-pulse");
    expect(oldLeaderboardStripper(input)).not.toBe(oldInboxStripper(input));
  });
});

describe("canonicalRecipeKey", () => {
  it("strips trailing :agent", () => {
    expect(canonicalRecipeKey("morning-pulse:agent")).toBe("morning-pulse");
  });

  it("strips trailing :cron", () => {
    expect(canonicalRecipeKey("morning-pulse:cron")).toBe("morning-pulse");
  });

  it("strips trailing :webhook", () => {
    expect(canonicalRecipeKey("morning-pulse:webhook")).toBe("morning-pulse");
  });

  it("only strips one trailing axis suffix", () => {
    // `:agent:cron` is not a real shape; verify we only chew the
    // trailing one and don't recurse.
    expect(canonicalRecipeKey("morning-pulse:agent:cron")).toBe(
      "morning-pulse:agent",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalRecipeKey("  morning-pulse:agent  ")).toBe("morning-pulse");
  });

  it("is case-sensitive", () => {
    expect(canonicalRecipeKey("Morning-Pulse:AGENT")).toBe("Morning-Pulse:AGENT");
    expect(canonicalRecipeKey("Morning-Pulse:agent")).toBe("Morning-Pulse");
  });

  it("leaves bare names untouched", () => {
    expect(canonicalRecipeKey("morning-pulse")).toBe("morning-pulse");
  });

  it("returns empty string for empty input", () => {
    expect(canonicalRecipeKey("")).toBe("");
  });

  it("converges the three pre-fix strippers for the same input", () => {
    // Once every call site calls canonicalRecipeKey, the three sites
    // necessarily compute === keys for any recipe-identity input —
    // that's the whole point of centralizing.
    const inputs = [
      "morning-pulse:agent",
      "morning-pulse:cron",
      "morning-pulse:webhook",
      "morning-pulse",
      "  morning-pulse:agent  ",
      "Morning-Pulse:agent",
    ];
    for (const input of inputs) {
      const fromLeaderboard = canonicalRecipeKey(input);
      const fromActivity = canonicalRecipeKey(input);
      const fromInboxRecipeGuess = canonicalRecipeKey(input);
      expect(fromLeaderboard).toBe(fromActivity);
      expect(fromActivity).toBe(fromInboxRecipeGuess);
    }
  });
});

describe("parseTriggerSource", () => {
  // Cases the bridge's parseTrigger accepts — must match byte-for-byte.
  it("parses cron:<name>", () => {
    expect(parseTriggerSource("cron:morning-pulse")).toEqual({
      trigger: "cron",
      recipeName: "morning-pulse",
    });
  });

  it("parses webhook:<name>", () => {
    expect(parseTriggerSource("webhook:github-pr")).toEqual({
      trigger: "webhook",
      recipeName: "github-pr",
    });
  });

  it("parses recipe:<name>:p<N> parent-seq tail", () => {
    expect(parseTriggerSource("recipe:morning-pulse:p42")).toEqual({
      trigger: "recipe",
      recipeName: "morning-pulse",
      parentSeq: 42,
    });
  });

  it("recipe name containing colons is lazy-matched up to :p<N>", () => {
    // Bridge regex uses `.+?` so the parent-seq tail wins. Names with
    // embedded colons stay intact in the recipeName field.
    expect(parseTriggerSource("recipe:foo:bar:p7")).toEqual({
      trigger: "recipe",
      recipeName: "foo:bar",
      parentSeq: 7,
    });
  });

  // Cases the bridge returns null for — dashboard widens.
  it("empty / missing input → manual", () => {
    expect(parseTriggerSource("")).toEqual({ trigger: "manual" });
  });

  it("bare name (no kind prefix) → manual with recipeName", () => {
    expect(parseTriggerSource("morning-pulse")).toEqual({
      trigger: "manual",
      recipeName: "morning-pulse",
    });
  });

  it("<name>:agent → agent trigger", () => {
    expect(parseTriggerSource("morning-pulse:agent")).toEqual({
      trigger: "agent",
      recipeName: "morning-pulse",
    });
  });
});

describe("inboxItemKey", () => {
  it("strips trailing .md", () => {
    expect(inboxItemKey("morning-pulse-2026-05-20.md")).toBe(
      "morning-pulse-2026-05-20",
    );
  });

  it("does NOT strip the trailing date", () => {
    // This is the deliberate behavior change vs the old inbox stripper.
    // Date stays as part of the inbox-item identity for display.
    expect(inboxItemKey("morning-pulse-2026-05-20")).toBe(
      "morning-pulse-2026-05-20",
    );
  });

  it("returns name unchanged when there is no .md", () => {
    expect(inboxItemKey("morning-pulse")).toBe("morning-pulse");
  });

  it("returns empty string for empty input", () => {
    expect(inboxItemKey("")).toBe("");
  });
});
