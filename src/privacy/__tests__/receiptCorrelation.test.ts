/**
 * A boundary receipt has to name the RUN that produced it.
 *
 * `recipeName` (#1474) tells an auditor which of 80 recipes to go and fix. It
 * does not tell them WHICH RUN — and a recipe that dispatches hourly produces a
 * receipt an hour that are indistinguishable from one another. The gate ledger
 * solved this in #1519: `correlationId` is the run's `taskId`, never `seq`,
 * which collided 255-of-272 on the live log.
 *
 * ## Why the field could not simply be added
 *
 * There is ONE write site (`recordBoundaryDecisionFn` in `yamlRunner`), reached
 * from four dep-builders. Three sit inside `runYamlRecipe`, where `runTaskId`
 * is already a local const. The fourth is `buildChainedDeps`, and it is called
 * from `recipeOrchestration`, `replayRun` and `commands/recipe` BEFORE
 * `runChainedRecipe` computes its `runTaskId` — so at deps-build time the
 * chained path has no run id to give.
 *
 * Filling the field on the flat path only would repeat the `stepId` this exact
 * ledger already declared, never supplied, and REMOVED rather than wired: a
 * declared-but-empty field tells a reader that attribution exists when it does
 * not. A half-covered join is worse than no join, because its absences stop
 * meaning one thing.
 *
 * So both runners are covered here, and the chained case is the load-bearing
 * test. A logic test on `record()` alone passes with every line of plumbing
 * deleted.
 *
 * ## The sentinel
 *
 * Every receipt is written from inside a run: all three chained call sites
 * dispatch into `runChainedRecipe`, which always computes a `runTaskId`, and
 * the flat sites are inside `runYamlRecipe`. So — exactly as the gate ledger
 * concluded — "recorded, legitimately no run" CANNOT occur here. A missing
 * `correlationId` at `rv >= 1` is a WRITER DEFECT, not a state, and absence of
 * `rv` means the row pre-dates this and is never backfilled.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BOUNDARY_RECORD_VERSION,
  BoundaryReceiptLog,
} from "../boundaryReceiptLog.js";
import { summariseBoundaryReceipts } from "../boundaryReceipts.js";

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "receipt-corr-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The ENFORCING key. Reaching for `privacy.shadow` here would prove nothing. */
function writeConfig(): void {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      privacy: {
        destinations: {
          "test-local": {
            type: "local",
            classifications: ["public", "internal", "personal"],
            drivers: ["local"],
          },
          "test-remote": {
            type: "remote",
            classifications: ["public", "internal"],
            drivers: ["claude", "claude-code", "subprocess"],
          },
        },
      },
    }),
  );
}

type Receipt = {
  rv?: number;
  correlationId?: string;
  recipeName?: string;
  decision?: string;
};

function readReceipts(): Receipt[] {
  try {
    return readFileSync(join(home, "boundary_receipts.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Receipt);
  } catch {
    return [];
  }
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATCHWORK_HOME;
  // PATCHWORK_HOME, not a spy on `os.homedir`: a namespace spy misses named
  // imports and has previously let a test write to the developer's real store.
  process.env.PATCHWORK_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prev;
  }
}

describe("the receipt ledger's record level", () => {
  it("stamps `rv` on every receipt, with no way for a caller to forge it", () => {
    const log = new BoundaryReceiptLog({ dir });
    const r = log.record({
      decision: "ALLOW",
      classification: "public",
      destinationId: "d",
      destinationType: "local",
      reason: "ok",
      correlationId: "yaml:x:1",
    });
    expect(r.rv).toBe(BOUNDARY_RECORD_VERSION);
    expect(r.correlationId).toBe("yaml:x:1");
  });

  it("omits `correlationId` rather than writing an empty one", () => {
    const log = new BoundaryReceiptLog({ dir });
    const r = log.record({
      decision: "ALLOW",
      classification: "public",
      destinationId: "d",
      destinationType: "local",
      reason: "ok",
    });
    // Absent, never `""` or null: a reader must be able to tell "no claim" from
    // "claim broken", and an empty string is neither.
    expect("correlationId" in r).toBe(false);
    expect(r.rv).toBe(BOUNDARY_RECORD_VERSION);
  });
});

describe("a boundary receipt names the run that produced it", () => {
  it("FLAT runner: the receipt's correlationId is the run's taskId", async () => {
    writeConfig();
    await withHome(async () => {
      const { runYamlRecipe } = await import("../../recipes/yamlRunner.js");
      await runYamlRecipe(
        {
          name: "flat-corr",
          trigger: { type: "manual" },
          steps: [
            {
              id: "think",
              agent: {
                prompt: "hi",
                driver: "claude-code",
                data_policy: { classification: "personal" },
              },
            },
          ],
        } as never,
        {
          testMode: true,
          logDir: dir,
          readFile: () => {
            throw new Error("nope");
          },
          writeFile: () => {},
          appendFile: () => {},
          mkdir: () => {},
          gitLogSince: () => "",
          gitStaleBranches: () => "",
          getDiagnostics: () => "",
          claudeFn: async () => "ok",
        } as never,
      );
    });

    const receipts = readReceipts();
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts) {
      expect(r.rv).toBe(BOUNDARY_RECORD_VERSION);
      // The flat runner's identity shape. Never `seq`.
      expect(r.correlationId).toMatch(/^yaml:flat-corr:\d+$/);
    }
  });

  it("CHAINED runner: the receipt's correlationId is the run's taskId", async () => {
    writeConfig();
    await withHome(async () => {
      const { runChainedRecipe } = await import(
        "../../recipes/chainedRunner.js"
      );
      const { buildChainedDeps } = await import("../../recipes/yamlRunner.js");
      const runnerDeps = {
        testMode: true,
        logDir: dir,
        readFile: () => {
          throw new Error("nope");
        },
        writeFile: () => {},
        appendFile: () => {},
        mkdir: () => {},
        gitLogSince: () => "",
        gitStaleBranches: () => "",
        getDiagnostics: () => "",
        claudeFn: async () => "ok",
        claudeCodeFn: async () => "ok",
      } as never;
      const chainedDeps = buildChainedDeps(
        runnerDeps,
        undefined,
        "chained-corr",
      );
      await runChainedRecipe(
        {
          name: "chained-corr",
          steps: [
            {
              id: "think",
              agent: {
                prompt: "hi",
                driver: "claude-code",
                data_policy: { classification: "personal" },
              },
            },
          ],
        } as never,
        {
          env: {},
          maxConcurrency: 1,
          maxDepth: 3,
          dryRun: false,
        } as never,
        chainedDeps,
      );
    });

    const receipts = readReceipts();
    // The load-bearing assertion. This is the path whose deps are built before
    // the run id exists; without the plumbing it produces receipts with no
    // correlationId while the flat test above still passes.
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts) {
      expect(r.rv).toBe(BOUNDARY_RECORD_VERSION);
      expect(r.correlationId).toMatch(/^chained:chained-corr:\d+$/);
    }
  });
});

describe("the reader carries the join through", () => {
  it("does not drop `rv` / `correlationId` on the way out", () => {
    // A ledger whose reader discards the field is the #1517 defect: rows
    // written correctly and dropped by every reader, so the feature is
    // invisible and looks unbuilt. `view()` enumerates fields explicitly, which
    // is the right shape and the reason a new field needs a line adding.
    const log = new BoundaryReceiptLog({ dir: home });
    log.record({
      decision: "LOCAL_ONLY",
      classification: "personal",
      destinationId: "test-remote",
      destinationType: "remote",
      reason: "nope",
      correlationId: "yaml:reader-check:7",
    });

    const summary = summariseBoundaryReceipts({ dir: home });
    const row = summary.recent[0];
    expect(row?.correlationId).toBe("yaml:reader-check:7");
    expect(row?.rv).toBe(BOUNDARY_RECORD_VERSION);
  });

  it("leaves a pre-protocol row's absent `rv` absent, never defaulted to 0", () => {
    // The sentinel. `parsed.rv ?? 0` on read is a backfill performed invisibly
    // on every load, and it would make a row that made no claim
    // indistinguishable from one that claimed level 0.
    writeFileSync(
      join(home, "boundary_receipts.jsonl"),
      `${JSON.stringify({
        seq: 1,
        at: 1,
        decision: "ALLOW",
        classification: "public",
        destinationId: "d",
        destinationType: "local",
        reason: "old row",
      })}\n`,
    );
    const summary = summariseBoundaryReceipts({ dir: home });
    expect(summary.recorded).toBe(1);
    expect("rv" in (summary.recent[0] ?? {})).toBe(false);
  });
});
