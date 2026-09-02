/**
 * The ledger's job is to keep raw evidence honest, so the tests that matter
 * are about what it must NOT do: invent a worker judgement it was never given,
 * inflate itself when re-run, or present a single snapshot as a history.
 */

import { describe, expect, it } from "vitest";
import {
  dedupeAgainst,
  formatLedgerSummary,
  PR_OBSERVATION_RV,
  type PrObservation,
  type RawGhPr,
  summarise,
  toObservation,
} from "../prOutcomeLedger.js";

const AT = "2026-08-27T12:00:00Z";

function raw(over: Partial<RawGhPr> = {}): RawGhPr {
  return {
    number: 1543,
    state: "MERGED",
    createdAt: "2026-08-27T08:44:27Z",
    mergedAt: "2026-08-27T10:51:15Z",
    additions: 395,
    deletions: 0,
    changedFiles: 5,
    author: { login: "a-maintainer", is_bot: false },
    mergeCommit: { oid: "31f7e15" },
    ...over,
  };
}

describe("toObservation", () => {
  it("keeps the raw fields a later pass will need", () => {
    const o = toObservation(raw(), { repo: "o/r", observedAt: AT });
    expect(o).toMatchObject({
      rv: PR_OBSERVATION_RV,
      repo: "o/r",
      number: 1543,
      state: "MERGED",
      additions: 395,
      changedFiles: 5,
      mergeCommitSha: "31f7e15",
    });
  });

  it("OMITS authorIsWorker when no roster is supplied", () => {
    // The load-bearing one. Defaulting to false would mark every historical
    // pull request as human-authored on no evidence.
    const o = toObservation(raw(), { repo: "o/r", observedAt: AT });
    expect(o).not.toBeNull();
    expect("authorIsWorker" in (o as object)).toBe(false);
  });

  it("records authorIsWorker as FALSE when a roster exists and excludes them", () => {
    // Distinct from the case above: here we genuinely know.
    const o = toObservation(raw(), {
      repo: "o/r",
      observedAt: AT,
      workerLogins: new Set(["some-worker"]),
    });
    expect(o?.authorIsWorker).toBe(false);
  });

  it("records authorIsWorker as true for a roster member", () => {
    const o = toObservation(raw({ author: { login: "some-worker" } }), {
      repo: "o/r",
      observedAt: AT,
      workerLogins: new Set(["some-worker"]),
    });
    expect(o?.authorIsWorker).toBe(true);
  });

  it("drops a row it cannot key rather than writing a placeholder", () => {
    expect(
      toObservation(raw({ number: undefined }), {
        repo: "o/r",
        observedAt: AT,
      }),
    ).toBeNull();
    expect(
      toObservation(raw({ author: null }), { repo: "o/r", observedAt: AT }),
    ).toBeNull();
    expect(
      toObservation(raw({ state: "DRAFTED" }), { repo: "o/r", observedAt: AT }),
    ).toBeNull();
  });
});

describe("dedupeAgainst", () => {
  const base = toObservation(raw(), {
    repo: "o/r",
    observedAt: AT,
  }) as PrObservation;

  it("drops an identical re-observation", () => {
    // Re-running the collector must not measure how often it ran.
    const again = { ...base, observedAt: "2026-08-27T13:00:00Z" };
    const r = dedupeAgainst([base], [again]);
    expect(r.toAppend).toHaveLength(0);
    expect(r.unchanged).toBe(1);
  });

  it("keeps an observation whose diff size moved", () => {
    const grown = {
      ...base,
      additions: 600,
      observedAt: "2026-08-27T13:00:00Z",
    };
    const r = dedupeAgainst([base], [grown]);
    expect(r.toAppend).toHaveLength(1);
    expect(r.firstSighting).toBe(0);
  });

  it("keeps an observation whose state moved", () => {
    const open = { ...base, state: "OPEN" as const, mergedAt: undefined };
    const r = dedupeAgainst([open], [base]);
    expect(r.toAppend).toHaveLength(1);
  });

  it("counts a pull request never seen before as a first sighting", () => {
    const other = { ...base, number: 1544 };
    const r = dedupeAgainst([base], [other]);
    expect(r.firstSighting).toBe(1);
  });
});

describe("summarise", () => {
  const a = toObservation(raw(), {
    repo: "o/r",
    observedAt: AT,
  }) as PrObservation;

  it("separates pull requests with a history from bare snapshots", () => {
    // A single observation is a final state, not a trajectory. Reporting them
    // together would let a one-shot backfill read as months of evidence.
    const grown = { ...a, additions: 600 };
    const only = { ...a, number: 1544 };
    const s = summarise([a, grown, only]);
    expect(s.distinctPrs).toBe(2);
    expect(s.prsWithHistory).toBe(1);
  });

  it("OMITS workerAuthored when no row carried a judgement", () => {
    const s = summarise([a]);
    expect(s.workerAuthored).toBeUndefined();
    expect(s.rosterlessRows).toBe(1);
  });

  it("reports workerAuthored as 0 when a roster was used and none matched", () => {
    // Zero-known-workers and no-roster must not render identically.
    const withRoster = toObservation(raw(), {
      repo: "o/r",
      observedAt: AT,
      workerLogins: new Set(["nobody"]),
    }) as PrObservation;
    const s = summarise([withRoster]);
    expect(s.workerAuthored).toBe(0);
    expect(s.rosterlessRows).toBe(0);
  });
});

describe("formatLedgerSummary", () => {
  it("says the clock has not started rather than printing a zero", () => {
    const out = formatLedgerSummary(summarise([]));
    expect(out).toMatch(/cannot be backfilled/);
    expect(out).not.toMatch(/0 pull request/);
  });

  it("never derives a score", () => {
    // Phase 1 records raw events. A scalar computed now would fix its
    // weighting before there is anything to weigh it against.
    //
    // Asserted on the DATA, not the prose: an earlier version of this test
    // grepped the output for "score" and failed on the sentence explaining
    // that no score is derived. The summary's own shape is the real contract.
    const a = toObservation(raw(), {
      repo: "o/r",
      observedAt: AT,
    }) as PrObservation;
    const s = summarise([a]);
    const scoreish = Object.keys(s).filter((k) =>
      /score|rating|grade|trust/i.test(k),
    );
    expect(scoreish).toEqual([]);
    // And no score is PRESENTED — a labelled numeric verdict, as distinct
    // from the sentence saying there isn't one.
    const out = formatLedgerSummary(s);
    expect(out).not.toMatch(/(score|rating|grade)\s*[:=]\s*[\d.]/i);
    expect(out).toMatch(/Raw events only/);
  });

  it("says unknown-worker rows are unknown, not false", () => {
    const a = toObservation(raw(), {
      repo: "o/r",
      observedAt: AT,
    }) as PrObservation;
    const out = formatLedgerSummary(summarise([a]));
    expect(out).toMatch(/unknown, not false/);
  });
});
