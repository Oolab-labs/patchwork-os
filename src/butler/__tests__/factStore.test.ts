/**
 * Fact-store durability tests.
 *
 * The headline property is the one the trace log deliberately does NOT have:
 * nothing is ever silently dropped. A belief store that forgets quietly is
 * worse than one that refuses to write.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ButlerFactStore } from "../factStore.js";

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-facts-"));
  clock = 1_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function store() {
  return new ButlerFactStore({ dir, now });
}

const BASE = {
  subject: "user",
  predicate: "diet.avoid",
  object: "shellfish",
  channel: "user_chat",
} as const;

describe("durability", () => {
  it("survives a restart", () => {
    store().remember(BASE);
    const reopened = store();
    expect(reopened.one("user", "diet.avoid")?.object).toBe("shellfish");
  });

  it("keeps the whole history, not just current beliefs", () => {
    const s = store();
    s.remember(BASE);
    clock += 100;
    s.remember({ ...BASE, object: "shellfish and peanuts" });
    expect(s.all()).toHaveLength(2);
    expect(s.recall()).toHaveLength(1);
  });

  it("never rotates — an old belief outlives a flood of new rows", () => {
    const s = store();
    const first = s.remember(BASE);
    for (let i = 0; i < 2_000; i++) {
      clock += 1;
      s.remember({
        subject: `noise.${i}`,
        predicate: "p",
        object: "x",
        channel: "recipe_agent",
      });
    }
    // The trace log would have trimmed the oldest rows by now.
    expect(s.all().some((f) => f.seq === first.seq)).toBe(true);
    expect(s.one("user", "diet.avoid")?.object).toBe("shellfish");
  });

  it("does not report a fact as stored when the write failed", () => {
    const s = store();
    rmSync(dir, { recursive: true, force: true }); // make the append fail
    expect(() => s.remember(BASE)).toThrow(/could not persist/);
    // and the in-memory view must not have kept it either
    expect(s.all().filter((f) => f.subject === "user")).toHaveLength(0);
  });
});

describe("provenance and trust", () => {
  it("stamps the channel tier and precomputes trust = min(tier, confidence)", () => {
    const f = store().remember({
      ...BASE,
      channel: "recipe_agent",
      contentConfidence: 0.4,
    });
    expect(f.provenance.tier).toBe(0.6);
    expect(f.trust).toBeCloseTo(0.4);
  });

  it("caps connector-derived text below the originate threshold", () => {
    const f = store().remember({ ...BASE, channel: "connector" });
    expect(f.trust).toBe(0.3);
    expect(f.trust).toBeLessThan(0.6);
  });

  it("marks only a human affirmation as validated", () => {
    const s = store();
    expect(
      s.remember({ ...BASE, channel: "recipe_agent" }).provenance.validated,
    ).toBe(false);
    expect(
      s.remember({ ...BASE, channel: "user_confirmed" }).provenance.validated,
    ).toBe(true);
  });

  it("stores the tier rather than recomputing it later", () => {
    // A future change to PROVENANCE_TIER must not retroactively rewrite what a
    // past row was trusted at.
    const f = store().remember({ ...BASE, channel: "connector" });
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, "facts.jsonl"), "utf8").trim(),
    );
    expect(onDisk.provenance.tier).toBe(f.provenance.tier);
    expect(onDisk.trust).toBe(f.trust);
  });
});

describe("ownership", () => {
  it("writes null rather than defaulting to an owner", () => {
    expect(store().remember(BASE).ownerId).toBeNull();
  });

  it("keeps a named owner when given one", () => {
    expect(store().remember({ ...BASE, ownerId: "u1" }).ownerId).toBe("u1");
  });
});

describe("forget", () => {
  it("writes a tombstone and stops resolving the belief", () => {
    const s = store();
    const f = s.remember(BASE);
    clock += 10;
    s.forget(f.seq);
    expect(s.one("user", "diet.avoid")).toBeUndefined();
    // original row still on disk
    expect(s.all().some((r) => r.seq === f.seq)).toBe(true);
  });

  it("refuses to retract a seq that does not exist", () => {
    expect(() => store().forget(999)).toThrow(/no fact with seq/);
  });
});

describe("validation", () => {
  it("rejects an empty subject or predicate", () => {
    const s = store();
    expect(() => s.remember({ ...BASE, subject: "  " })).toThrow(/subject/);
    expect(() => s.remember({ ...BASE, predicate: "" })).toThrow(/predicate/);
  });

  it("rejects null bytes anywhere", () => {
    const s = store();
    expect(() => s.remember({ ...BASE, subject: "a\0b" })).toThrow(/null byte/);
    expect(() => s.remember({ ...BASE, object: "a\0b" })).toThrow(/null byte/);
  });

  it("rejects an over-long object rather than truncating it", () => {
    // Truncation would store a DIFFERENT belief than the one asserted.
    expect(() =>
      store().remember({ ...BASE, object: "x".repeat(513) }),
    ).toThrow(/exceeds/);
  });

  it("allows an empty object as an explicit 'none'", () => {
    expect(store().remember({ ...BASE, object: "" }).object).toBe("");
  });

  it("rejects an out-of-range confidence", () => {
    expect(() => store().remember({ ...BASE, contentConfidence: 1.5 })).toThrow(
      /between 0 and 1/,
    );
  });
});

describe("concurrency (ADR-0007 tail-on-read)", () => {
  it("sees a row appended by another process", () => {
    const a = store();
    const b = store();
    a.remember(BASE);
    expect(b.one("user", "diet.avoid")?.object).toBe("shellfish");
  });

  it("does not reissue a seq another process already used", () => {
    const a = store();
    const b = store();
    const fromA = a.remember(BASE);
    const fromB = b.remember({ ...BASE, object: "peanuts" });
    expect(fromB.seq).toBeGreaterThan(fromA.seq);
  });

  it("reloads cleanly if the file shrinks underneath it", () => {
    const s = store();
    s.remember(BASE);
    writeFileSync(path.join(dir, "facts.jsonl"), "");
    expect(s.all()).toHaveLength(0);
  });
});

describe("corrupt rows are reported, never silently swallowed", () => {
  it("warns when a row cannot be parsed", () => {
    const warn = vi.fn();
    const s = new ButlerFactStore({ dir, now });
    s.remember(BASE);
    writeFileSync(
      path.join(dir, "facts.jsonl"),
      `${JSON.stringify({ broken: true })}\nnot json at all\n`,
    );
    const reopened = new ButlerFactStore({ dir, now, logger: { warn } });
    expect(reopened.all()).toHaveLength(0);
    // Two bad rows: one unparseable, one malformed.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/missing|malformed/);
  });
});
