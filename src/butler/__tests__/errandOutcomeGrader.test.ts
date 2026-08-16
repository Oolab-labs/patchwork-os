/**
 * Butler errand outcome grader + shadow ledger.
 *
 * The tests that matter here are the ones about ABSENCE. Four separate defects
 * in this subsystem (#1064, #1318/#1319, #1320, #1322) were all the same
 * mistake — something that was merely not-negative being folded as positive —
 * so the grader is tested primarily on what it REFUSES to call good.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STALE_AFTER_MS,
  gradeErrandOutcome,
} from "../errandOutcomeGrader.js";
import {
  appendShadowOutcome,
  SHADOW_LOG_BASENAME,
  shadowLogPath,
  summariseShadowLog,
} from "../outcomeShadowLog.js";

const NOW = 1_760_000_000_000;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-shadow-"));
});

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("gradeErrandOutcome — positive acts", () => {
  it("completed → confirmed", () => {
    expect(
      gradeErrandOutcome({ completed: true, createdAt: NOW }, { now: NOW }),
    ).toEqual({ disposition: "confirmed", reason: "completed" });
  });

  it("deleted → junk", () => {
    expect(
      gradeErrandOutcome({ deleted: true, createdAt: NOW }, { now: NOW }),
    ).toEqual({ disposition: "junk", reason: "deleted" });
  });

  it("deleted WINS over completed on a contradictory pair", () => {
    // A tracker can report both when an operator completes then clears a task.
    // "They threw it away" is the conservative reading: it lowers trust rather
    // than raising it on ambiguous evidence.
    expect(
      gradeErrandOutcome(
        { completed: true, deleted: true, createdAt: NOW },
        { now: NOW },
      ).disposition,
    ).toBe("junk");
  });
});

describe("gradeErrandOutcome — absence is never a positive", () => {
  it("open + recent → WITHHELD, not confirmed", () => {
    // The load-bearing rule. An errand nobody deleted looks like a success and
    // is not one — the operator may simply not have looked yet.
    // `stateObserved` because this case is "we LOOKED and it was still open".
    // Without it the answer is `not-observed`, which is a different fact.
    const r = gradeErrandOutcome(
      { createdAt: NOW - 60_000, stateObserved: true },
      { now: NOW },
    );
    expect(r.disposition).toBe("unknown");
    expect(r.reason).toBe("open-recent");
  });

  it("nothing observed at all → WITHHELD", () => {
    expect(gradeErrandOutcome({}, { now: NOW }).disposition).toBe("unknown");
  });

  it("completed:false is not a positive", () => {
    expect(
      gradeErrandOutcome(
        { completed: false, deleted: false, createdAt: NOW },
        { now: NOW },
      ).disposition,
    ).toBe("unknown");
  });

  it("NO input produces `confirmed` without an explicit completion", () => {
    // Exhaustive over the observable shapes rather than a spot check: the
    // failure mode being guarded is a branch nobody thought about reaching
    // `confirmed`, so enumerate them.
    const bools = [undefined, true, false];
    for (const completed of bools) {
      for (const deleted of bools) {
        for (const createdAt of [
          undefined,
          NOW,
          NOW - DEFAULT_STALE_AFTER_MS,
        ]) {
          const r = gradeErrandOutcome(
            {
              ...(completed !== undefined && { completed }),
              ...(deleted !== undefined && { deleted }),
              ...(createdAt !== undefined && { createdAt }),
            },
            { now: NOW },
          );
          if (r.disposition === "confirmed") {
            expect(completed).toBe(true);
            expect(deleted).not.toBe(true);
          }
        }
      }
    }
  });
});

describe("silence is only evidence if somebody was listening", () => {
  // The staleness rule converts silence into a negative. That is sound only
  // when a completion COULD have been seen. An ingester deriving artifacts
  // from the local run log knows creation times and nothing about what the
  // operator later did, so without this guard every errand older than the
  // horizon grades `junk` — not because it was ignored, but because nobody
  // asked. Trust-by-neglect with its sign flipped, and worse: a worker cannot
  // appeal a verdict nobody looked at.

  it("age alone does NOT produce junk when state was never observed", () => {
    const r = gradeErrandOutcome(
      { createdAt: NOW - DEFAULT_STALE_AFTER_MS * 10 },
      { now: NOW },
    );
    expect(r.disposition).toBe("unknown");
    expect(r.reason).toBe("not-observed");
  });

  it("stateObserved:false is treated exactly like absent", () => {
    // A channel that reports "I could not check" must not be luckier than one
    // that says nothing.
    const r = gradeErrandOutcome(
      { createdAt: NOW - DEFAULT_STALE_AFTER_MS * 10, stateObserved: false },
      { now: NOW },
    );
    expect(r.disposition).toBe("unknown");
    expect(r.reason).toBe("not-observed");
  });

  it("observing the state re-enables the negative (control)", () => {
    // Without this the two assertions above hold just as well for a grader
    // that never returns junk at all, which would assert nothing.
    expect(
      gradeErrandOutcome(
        { createdAt: NOW - DEFAULT_STALE_AFTER_MS * 10, stateObserved: true },
        { now: NOW },
      ).disposition,
    ).toBe("junk");
  });

  it("a positive act still counts without stateObserved", () => {
    // `completed`/`deleted` ARE observations — requiring a separate flag
    // alongside them would discard real evidence.
    expect(
      gradeErrandOutcome({ completed: true }, { now: NOW }).disposition,
    ).toBe("confirmed");
    expect(
      gradeErrandOutcome({ deleted: true }, { now: NOW }).disposition,
    ).toBe("junk");
  });
});

describe("gradeErrandOutcome — staleness converts silence into a negative", () => {
  it("open past the horizon → junk", () => {
    const r = gradeErrandOutcome(
      { createdAt: NOW - DEFAULT_STALE_AFTER_MS, stateObserved: true },
      { now: NOW },
    );
    expect(r.disposition).toBe("junk");
    expect(r.reason).toBe("stale-unactioned");
  });

  it("one millisecond BEFORE the horizon is still withheld", () => {
    // Boundary pinned from both sides so an off-by-one cannot silently turn
    // "still deciding" into a negative against a worker.
    expect(
      gradeErrandOutcome(
        { createdAt: NOW - DEFAULT_STALE_AFTER_MS + 1, stateObserved: true },
        { now: NOW },
      ).disposition,
    ).toBe("unknown");
  });

  it("honours an injected horizon", () => {
    expect(
      gradeErrandOutcome(
        { createdAt: NOW - 5_000, stateObserved: true },
        { now: NOW, staleAfterMs: 1_000 },
      ).disposition,
    ).toBe("junk");
  });

  it("is a pure function of its inputs — same input, same verdict", () => {
    // A prior LLM judge flipped verdicts between runs on identical inputs,
    // which makes the ledger unreplayable. Determinism is the requirement that
    // rules a model out of this path.
    const input = { createdAt: NOW - 100 } as const;
    const a = gradeErrandOutcome(input, { now: NOW });
    for (let i = 0; i < 25; i++) {
      expect(gradeErrandOutcome(input, { now: NOW })).toEqual(a);
    }
  });
});

describe("shadow ledger", () => {
  it("records the grade and whether it WOULD have counted", () => {
    appendShadowOutcome(
      {
        ref: "todoist.create_task:abc123",
        disposition: "confirmed",
        reason: "completed",
        gradedAt: NOW,
        recipe: "example-errand",
      },
      { dir },
    );
    const rows = readFileSync(shadowLogPath(dir), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].wouldCountAsEvidence).toBe(true);
  });

  it("marks a withheld grade as NOT evidence", () => {
    appendShadowOutcome(
      {
        ref: "todoist.create_task:def456",
        disposition: "unknown",
        reason: "open-recent",
        gradedAt: NOW,
      },
      { dir },
    );
    const row = JSON.parse(readFileSync(shadowLogPath(dir), "utf-8").trim());
    expect(row.wouldCountAsEvidence).toBe(false);
  });

  it("summarises, skipping malformed lines", () => {
    for (const d of ["confirmed", "junk", "unknown"] as const) {
      appendShadowOutcome(
        { ref: `t:${d}`, disposition: d, reason: "completed", gradedAt: NOW },
        { dir },
      );
    }
    // A half-written row from an interrupted append must not inflate a count
    // someone is about to make a decision on.
    appendFileSync(shadowLogPath(dir), '{"ref":"broken\n');
    const s = summariseShadowLog({ dir });
    expect(s.total).toBe(3);
    expect(s.confirmed).toBe(1);
    expect(s.junk).toBe(1);
    expect(s.unknown).toBe(1);
    expect(s.wouldCount).toBe(2);
  });

  it("an unwritable ledger never throws", () => {
    // A measurement must not be able to fail the errand it is observing.
    expect(() =>
      appendShadowOutcome(
        {
          ref: "t:1",
          disposition: "junk",
          reason: "deleted",
          gradedAt: NOW,
        },
        { dir: path.join(dir, "does", "not", "exist") },
      ),
    ).not.toThrow();
  });

  it("summarising a missing ledger returns zeros, not an error", () => {
    expect(summariseShadowLog({ dir: path.join(dir, "nope") }).total).toBe(0);
  });
});

describe("SHADOW means shadow — the trust fold must not read this file", () => {
  it("no production source reads the shadow ledger except its own module", () => {
    // The safety property of this phase, pinned to the code. If someone wires
    // the shadow ledger into the fold, this fails and forces the measured
    // promotion step (#1319's pattern) instead of a silent flip.
    const repo = path.resolve(import.meta.dirname, "..", "..", "..");
    // `--untracked` so this is meaningful BEFORE the files are committed — a
    // guard that only worked post-commit would pass vacuously on the very
    // change that introduces the risk. `git grep` exits 1 on no matches, which
    // is a legitimate result here, so it is caught rather than thrown.
    let out = "";
    try {
      out = execFileSync(
        "git",
        ["grep", "-l", "--untracked", SHADOW_LOG_BASENAME, "--", "src"],
        { cwd: repo, encoding: "utf8" },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status !== 1) throw err;
      out = e.stdout ?? "";
    }
    const hits = out
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("__tests__"));
    expect(hits).toEqual(["src/butler/outcomeShadowLog.ts"]);
  });

  it("only the ingester and the CLI reach the shadow ledger's module", () => {
    // The check above greps the FILENAME, so it cannot see a module that
    // reaches the ledger through `shadowLogPath()` / `summariseShadowLog()` —
    // which is exactly how a reader would actually be written, and how
    // outcomeIngester.ts does it. It caught that module only by its comment.
    //
    // So enumerate importers too. The allowlist is the point: adding a module
    // here is a deliberate act, and the one module that must NEVER appear is
    // anything in workers/ — that is the fold.
    const repo = path.resolve(import.meta.dirname, "..", "..", "..");
    let out = "";
    try {
      out = execFileSync(
        "git",
        ["grep", "-l", "--untracked", "outcomeShadowLog", "--", "src"],
        { cwd: repo, encoding: "utf8" },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status !== 1) throw err;
      out = e.stdout ?? "";
    }
    const importers = out
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => f !== "src/butler/outcomeShadowLog.ts")
      .sort();

    expect(importers).toEqual([
      "src/butler/outcomeIngester.ts",
      "src/index.ts",
    ]);
    // Restated as a property, not just a list: whatever the allowlist grows
    // to, nothing under workers/ may ever read this file.
    for (const f of importers) expect(f).not.toMatch(/^src\/workers\//);
  });

  it("the grader module does not import the outcome store's writer", () => {
    // `OutcomeStore.upsert` is the function that makes something evidence.
    // Grading must not be able to call it.
    const src = readFileSync(
      path.resolve(import.meta.dirname, "..", "errandOutcomeGrader.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/\bOutcomeStore\b/);
    expect(src).not.toMatch(/\bupsert\b/);
  });
});

describe("silence is only a decision if somebody was asked", () => {
  // The backfill hazard. `stateObserved` separates "nobody looked" from "we
  // looked". It does NOT separate "nobody was asked" from "somebody declined
  // to act" — and on the first real ingest, every errand filed before the
  // observation channel existed is the former. We genuinely did look, so the
  // stateObserved guard passes, and a 60-day-old open errand grades `junk`:
  // an unearned negative against a worker, on day one, from a loop the
  // operator never knew they were in.

  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

  it("an old errand first seen TODAY is open-recent, not junk", () => {
    const r = gradeErrandOutcome(
      {
        createdAt: NOW - SIXTY_DAYS,
        stateObserved: true,
        watchedSince: NOW, // first observation is this run
      },
      { now: NOW },
    );
    expect(r.disposition).toBe("unknown");
    expect(r.reason).toBe("open-recent");
  });

  it("the same errand goes junk once WATCHED past the horizon", () => {
    // Control: without this, "never grade old errands" would pass the test
    // above while disabling the staleness rule entirely.
    const r = gradeErrandOutcome(
      {
        createdAt: NOW - SIXTY_DAYS,
        stateObserved: true,
        watchedSince: NOW - DEFAULT_STALE_AFTER_MS,
      },
      { now: NOW },
    );
    expect(r.disposition).toBe("junk");
    expect(r.reason).toBe("stale-unactioned");
  });

  it("watchedSince cannot make a NEW errand stale early", () => {
    // max(), not replace. A watchedSince older than creation — a corrupt row,
    // a clock skew — must not age an errand that did not exist yet.
    const r = gradeErrandOutcome(
      {
        createdAt: NOW - 1000,
        stateObserved: true,
        watchedSince: NOW - SIXTY_DAYS,
      },
      { now: NOW },
    );
    expect(r.disposition).toBe("unknown");
  });

  it("absent watchedSince preserves the old behaviour", () => {
    // Callers that have genuinely been watching since creation are unaffected.
    const r = gradeErrandOutcome(
      { createdAt: NOW - DEFAULT_STALE_AFTER_MS, stateObserved: true },
      { now: NOW },
    );
    expect(r.disposition).toBe("junk");
  });
});
