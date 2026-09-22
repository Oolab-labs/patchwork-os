import { describe, expect, it } from "vitest";
import { ageInWords, factInWords, termInWords } from "../factWords";

/**
 * The rule under test is mostly a rule about what this module REFUSES to do.
 * Butler's predicates are operator-authored and unbounded, so every test here
 * that passes an unfamiliar one is checking that nothing was invented.
 */

describe("a fact reads as a labelled value, not a database row", () => {
  it("drops the subject when the fact is about the reader", () => {
    // "You — tasks default list: personal" was the shape that made Home read
    // like a table. On a page headed "What I know about you", "You" is noise.
    const w = factInWords({
      subject: "user",
      predicate: "tasks.default_list",
      object: "personal",
    });
    expect(w).toEqual({ term: "Tasks default list", value: "personal" });
    expect(JSON.stringify(w)).not.toContain("You");
  });

  it("keeps a subject that is somebody else", () => {
    // A fact about another person is a different claim and must not silently
    // read as one about the reader.
    const w = factInWords({
      subject: "household.spouse",
      predicate: "timezone",
      object: "Europe/Lisbon",
    });
    expect(w.about).toBe("Household spouse");
  });

  it("says so when a belief has no value", () => {
    // An empty cell reads as a rendering fault; this is a real state.
    expect(
      factInWords({ subject: "user", predicate: "coffee", object: "" }).value,
    ).toBe("(nothing recorded)");
  });

  it("never rewords the value", () => {
    const odd = "  Europe/London (since the move) ";
    expect(
      factInWords({ subject: "user", predicate: "timezone", object: odd })
        .value,
    ).toBe(odd);
  });
});

describe("terms are humanised, never guessed at", () => {
  it("turns separators into spaces and capitalises once", () => {
    expect(termInWords("tasks.default_list")).toBe("Tasks default list");
    expect(termInWords("diet.avoid")).toBe("Diet avoid");
    expect(termInWords("working_hours")).toBe("Working hours");
  });

  it("does not stem, pluralise or reorder", () => {
    // Every one of those would be a guess about a word never seen before.
    // "Diet avoid" is slightly awkward and TRUE; "You avoid" is invented.
    expect(termInWords("travel.prefers")).toBe("Travel prefers");
    expect(termInWords("likes")).toBe("Likes");
  });

  it("leaves an unfamiliar predicate legible rather than mangled", () => {
    for (const p of ["x", "p", "a.b.c.d", "SHOUTING", "already spaced"]) {
      const t = termInWords(p);
      expect(t.length).toBeGreaterThan(0);
      // Nothing is dropped: every original word survives.
      for (const word of p.split(/[._-]+/).filter(Boolean)) {
        expect(t.toLowerCase()).toContain(word.toLowerCase());
      }
    }
  });

  it("returns the predicate itself when there is nothing to humanise", () => {
    expect(termInWords("...")).toBe("...");
  });
});

describe("age answers 'is this still true?'", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  const daysAgo = (n: number) => now - n * 86_400_000;

  it("is coarse and relative", () => {
    expect(ageInWords(daysAgo(0), now)).toBe("today");
    expect(ageInWords(daysAgo(1), now)).toBe("yesterday");
    expect(ageInWords(daysAgo(5), now)).toBe("5 days ago");
    expect(ageInWords(daysAgo(21), now)).toBe("3 weeks ago");
    expect(ageInWords(daysAgo(200), now)).toBe("6 months ago");
    expect(ageInWords(daysAgo(900), now)).toBe("2 years ago");
  });

  it("does not render a future timestamp as a negative age", () => {
    // Clocks disagree; "-3 days ago" is a bug report, not an answer.
    expect(ageInWords(now + 60_000, now)).toBe("just now");
  });

  it("never returns an empty string", () => {
    for (const d of [0, 1, 13, 14, 63, 64, 364, 365, 5000]) {
      expect(ageInWords(daysAgo(d), now)).not.toBe("");
    }
  });
});
