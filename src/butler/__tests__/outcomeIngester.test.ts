/**
 * The Butler outcome ingester: grades into the SHADOW ledger, and cannot do
 * anything else.
 *
 * Two properties matter more than the arithmetic:
 *
 *  1. **It is not reachable from a recipe step.** A recipe step runs as the
 *     worker. If grading were reachable from one, a worker whose errands
 *     nobody looks at could emit `completed: true` for each and manufacture
 *     the evidence that raises its own trust dial — the same defect as #1064,
 *     #1318/#1319, #1320 and #1322, which is four times. `outcomes confirm` is
 *     a CLI verb for exactly this reason, and so is this.
 *
 *  2. **It cannot promote.** No path from here reaches `outcome-log.jsonl`.
 *     Asserted against the module SOURCE, because the guarantee is structural
 *     — a future edit adding an `OutcomeStore` import would compile and pass
 *     every behavioural test in this file while silently making shadow rows
 *     real.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_STALE_AFTER_MS } from "../errandOutcomeGrader.js";
import {
  type ErrandObservation,
  formatShadowSummary,
  ingestErrandOutcomes,
} from "../outcomeIngester.js";
import {
  SHADOW_LOG_BASENAME,
  summariseShadowLog,
} from "../outcomeShadowLog.js";

const NOW = 1_800_000_000_000;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-ingest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rows(): Record<string, unknown>[] {
  const text = readFileSync(path.join(dir, SHADOW_LOG_BASENAME), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("grading a batch", () => {
  it("writes one row per observation with the disposition and its reason", () => {
    const obs: ErrandObservation[] = [
      { ref: "todoist.create_task:a", completed: true, recipe: "errands" },
      { ref: "todoist.create_task:b", deleted: true },
      {
        ref: "todoist.create_task:c",
        createdAt: NOW - 60_000,
        stateObserved: true,
      },
    ];
    const r = ingestErrandOutcomes(obs, { now: NOW, dir });

    expect(r.graded).toBe(3);
    expect(r.batch).toEqual({ confirmed: 1, junk: 1, unknown: 1 });

    const written = rows();
    expect(written).toHaveLength(3);
    expect(written[0]).toMatchObject({
      ref: "todoist.create_task:a",
      disposition: "confirmed",
      reason: "completed",
      recipe: "errands",
      wouldCountAsEvidence: true,
    });
    expect(written[2]).toMatchObject({
      disposition: "unknown",
      reason: "open-recent",
      wouldCountAsEvidence: false,
    });
  });

  it("an unobserved old errand is withheld, not marked junk", () => {
    // The defect this ingester would otherwise create. Age alone cannot tell
    // "the operator ignored it" from "nobody ever looked", and only the first
    // is evidence — against the worker.
    const r = ingestErrandOutcomes(
      [{ ref: "t:1", createdAt: NOW - DEFAULT_STALE_AFTER_MS * 10 }],
      { now: NOW, dir },
    );
    expect(r.batch).toEqual({ confirmed: 0, junk: 0, unknown: 1 });
    expect(rows()[0]).toMatchObject({
      disposition: "unknown",
      reason: "not-observed",
    });
  });

  it("the same errand, WATCHED past the horizon, still goes junk (control)", () => {
    // Without this the assertion above holds for an ingester that never
    // records a negative at all.
    //
    // `watchedSince` is explicit here because it is what the assertion is
    // about. This test previously passed with only `createdAt`, which is the
    // backfill hazard: an errand filed long ago but first seen NOW graded
    // junk on day one, from a loop the operator never knew they were in.
    const r = ingestErrandOutcomes(
      [
        {
          ref: "t:1",
          createdAt: NOW - DEFAULT_STALE_AFTER_MS * 10,
          stateObserved: true,
          watchedSince: NOW - DEFAULT_STALE_AFTER_MS,
        },
      ],
      { now: NOW, dir },
    );
    expect(r.batch.junk).toBe(1);
  });

  it("reports skipped observations instead of dropping them", () => {
    const r = ingestErrandOutcomes(
      [
        { ref: "  ", completed: true },
        { ref: "t:dup", completed: true },
        { ref: "t:dup", deleted: true },
      ] as ErrandObservation[],
      { now: NOW, dir },
    );
    expect(r.graded).toBe(1);
    expect(r.skipped).toEqual([
      { reason: "missing-ref" },
      { ref: "t:dup", reason: "duplicate-ref" },
    ]);
    // A silently-dropped observation would understate the ledger a human is
    // about to read a promotion decision off.
    expect(rows()).toHaveLength(1);
  });

  it("appends across batches rather than replacing", () => {
    // Successive observations of one artifact over time are the point: they
    // are what shows an errand going from open to completed.
    ingestErrandOutcomes(
      [{ ref: "t:1", createdAt: NOW, stateObserved: true }],
      {
        now: NOW,
        dir,
      },
    );
    ingestErrandOutcomes([{ ref: "t:1", completed: true }], {
      now: NOW + 1000,
      dir,
    });
    expect(rows()).toHaveLength(2);
    expect(summariseShadowLog({ dir })).toMatchObject({
      total: 2,
      confirmed: 1,
      unknown: 1,
    });
  });
});

describe("it cannot promote, and cannot be called by a worker", () => {
  const SRC = readFileSync(
    path.join(import.meta.dirname, "..", "outcomeIngester.ts"),
    "utf-8",
  );

  /**
   * Import statements only — the prose above them names `OutcomeStore` and
   * `outcome-log.jsonl` precisely to explain why they are absent, and a
   * whole-file grep fails on the documentation rather than on the code. That
   * version of this test was written first and failed immediately, which is
   * the cheapest possible demonstration that it discriminates.
   */
  const IMPORTS = SRC.split("\n").filter((l) => /^import\b/.test(l.trim()));

  it("imports nothing that can reach the real outcome log", () => {
    // Structural, not conventional: an added import would compile and pass
    // every behavioural test above while making shadow rows real.
    expect(IMPORTS.length).toBeGreaterThan(0);
    for (const line of IMPORTS) {
      expect(line).not.toMatch(/OutcomeStore/);
      expect(line).not.toMatch(/outcomeStore/);
      expect(line).not.toMatch(/\.\.\/workers\//);
    }
    // The whole module body, excluding the header comment, must not name it
    // either — a dynamic `await import()` would evade the line filter above.
    const body = SRC.slice(SRC.indexOf("*/") + 2);
    expect(body).not.toMatch(/OutcomeStore|outcomeStore|workers\//);
  });

  it("is not registered as a recipe tool", () => {
    // A recipe step runs AS the worker, so a worker could grade its own
    // filings. `outcomes confirm` is a CLI verb for this reason and so is
    // this. Checked against the registry's own import barrel — the file that
    // decides what a recipe can call.
    const barrel = readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "recipes",
        "tools",
        "index.ts",
      ),
      "utf-8",
    );
    expect(barrel).not.toMatch(/outcomeIngester/);
    expect(barrel).not.toMatch(/butler\/outcome/);
    expect(SRC).not.toMatch(/registerTool/);
  });
});

describe("the summary states the promotion bar", () => {
  it("refuses to imply readiness when nothing has been measured", () => {
    const out = formatShadowSummary(summariseShadowLog({ dir }));
    expect(out).toContain("no graded rows yet");
    expect(out).toContain("nothing may be promoted");
  });

  it("reports what would have counted, and says it moved nothing", () => {
    ingestErrandOutcomes(
      [
        { ref: "t:1", completed: true },
        { ref: "t:2", createdAt: NOW, stateObserved: true },
      ],
      { now: NOW, dir },
    );
    const out = formatShadowSummary(summariseShadowLog({ dir }));
    expect(out).toContain("2 graded row(s)");
    expect(out).toContain("1 row(s) (50.0%) would have become evidence");
    expect(out).toContain("These rows moved nothing");
  });
});

describe("the real CLI entry point", () => {
  // Drives `dist/index.js` as a subprocess. The in-process tests above cannot
  // see missing wiring: they import the module directly, so they would pass
  // just as happily if `patchwork butler` dispatched to nothing at all — which
  // is the state this whole phase was in, a merged grader nobody could call.
  const DIST = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "dist",
    "index.js",
  );

  it.skipIf(!existsSync(DIST))(
    "grades from stdin and writes ONLY the shadow ledger",
    () => {
      const observations = JSON.stringify([
        { ref: "todoist.create_task:1", completed: true },
        { ref: "todoist.create_task:2", createdAt: 1, stateObserved: true },
        // No stateObserved: ancient, but nobody looked. Must NOT be junk.
        { ref: "todoist.create_task:3", createdAt: 1 },
      ]);
      const out = execFileSync(process.execPath, [DIST, "butler", "ingest"], {
        input: observations,
        encoding: "utf-8",
        env: { ...process.env, PATCHWORK_HOME: dir },
      });

      expect(out).toContain("1 confirmed, 1 junk, 1 unknown");

      // The safety property, checked where it actually matters. The
      // PATCHWORK_HOME override is self-verifying here: the shadow file lands
      // in `dir`, so the absence check below cannot pass vacuously by the CLI
      // having written somewhere else entirely.
      expect(existsSync(path.join(dir, SHADOW_LOG_BASENAME))).toBe(true);
      expect(existsSync(path.join(dir, "outcome-log.jsonl"))).toBe(false);

      const written = rows();
      expect(written).toHaveLength(3);
      expect(written[2]).toMatchObject({
        disposition: "unknown",
        reason: "not-observed",
      });
    },
  );

  it.skipIf(!existsSync(DIST))("summarises without implying readiness", () => {
    const out = execFileSync(process.execPath, [DIST, "butler", "shadow"], {
      encoding: "utf-8",
      env: { ...process.env, PATCHWORK_HOME: dir },
    });
    expect(out).toContain("nothing may be promoted");
  });
});

describe("the first ingest cannot manufacture a batch of negatives", () => {
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

  it("an ancient open errand grades unknown on first sight, junk later", () => {
    // Drives the real ingester twice against the SAME ledger, which is where
    // `watchedSince` comes from — the first run has no prior row, so the
    // errand has been watched for zero time.
    const ancient = {
      ref: "todoist.create_task:old",
      createdAt: NOW - SIXTY_DAYS,
      stateObserved: true,
    };

    const first = ingestErrandOutcomes([ancient], { now: NOW, dir });
    expect(first.batch).toEqual({ confirmed: 0, junk: 0, unknown: 1 });
    expect(rows()[0]).toMatchObject({ reason: "open-recent" });

    // Watched for a full horizon now. Same errand, same age — different
    // answer, because now the operator HAS had it in front of them.
    const later = ingestErrandOutcomes([ancient], {
      now: NOW + DEFAULT_STALE_AFTER_MS,
      dir,
    });
    expect(later.batch.junk).toBe(1);
  });

  it("a whole backfill batch yields zero evidence on day one", () => {
    // The shape of a real first ingest: several historical errands, all open,
    // all older than the horizon. Before this fix every one of them was junk.
    const batch = ["a", "b", "c"].map((id) => ({
      ref: `todoist.create_task:${id}`,
      createdAt: NOW - SIXTY_DAYS,
      stateObserved: true,
    }));
    const r = ingestErrandOutcomes(batch, { now: NOW, dir });
    expect(r.batch).toEqual({ confirmed: 0, junk: 0, unknown: 3 });
    expect(r.ledger.wouldCount).toBe(0);
  });

  it("a completed errand still counts on first sight (control)", () => {
    // `watchedSince` gates only the staleness rule. A positive ACT is
    // evidence whenever it is seen — otherwise this fix would suppress the
    // good news along with the bad.
    const r = ingestErrandOutcomes(
      [{ ref: "todoist.create_task:done", completed: true }],
      { now: NOW, dir },
    );
    expect(r.batch.confirmed).toBe(1);
  });
});
