/**
 * The shadow ledger could not name the run it observed.
 *
 * `boundary_receipts.jsonl` carries `correlationId` (#1522). `privacy_shadow
 * .jsonl` does not, and the two are written 26 lines apart in the same
 * function, from the same dispatch, with the same `runTaskId` in scope.
 * Measured on the reference machine: 109 of 265 receipts carry a run id and
 * 0 of 310 shadow rows do.
 *
 * This is the exact MIRROR of a defect this code has already recorded twice in
 * its own comments. #1469 added `recipeName` to the shadow ledger and stopped
 * there, "leaving the ENFORCING ledger anonymous"; #1474 closed that and its
 * comment says both ledgers "describe the same dispatch, so a receipt that
 * omitted this would leave the ENFORCING log unable to say what the observing
 * one could". `correlationId` then went the other way — onto the enforcing
 * ledger only — and left the observing one anonymous.
 *
 * What that costs is specific, not tidiness. Shadow mode exists to answer "what
 * would a candidate policy have stopped?" and its sharpest form is "where do my
 * live policy and my candidate policy disagree, ON THIS RUN?". That question is
 * a join between these two files, and it could not be asked.
 *
 * ## The sentinel, and why this ledger's registry differs from the receipt's
 *
 * `correlationId` at `rv >= 1` is "never legitimately absent" for receipts,
 * because every receipt is written from inside a run. This ledger has TWO write
 * paths. `recipe-agent-step` runs inside `runYamlRecipe` / `runChainedRecipe`
 * and always has a run. `orchestrator-task` is `runClaudeTask` and automation
 * hooks — dispatches that are not recipe runs and have no row in `runs.jsonl`
 * at all. Stamping those with something run-shaped would assert a run that
 * never existed, which is the failure the approval ledger's own sentinel design
 * calls out. So absence on the orchestrator path is a registered
 * NOT-APPLICABLE condition, and absence on the recipe path is a writer defect.
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

import { recordPrivacyShadow, SHADOW_RECORD_VERSION } from "../shadowLog.js";

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "shadow-corr-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * BOTH keys. The enforcing one so a receipt is written, the shadow one so an
 * observation is — the whole point is that the two rows can be joined.
 */
function writeConfig(): void {
  const destinations = {
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
  };
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ privacy: { destinations, shadow: { destinations } } }),
  );
}

type Row = { rv?: number; correlationId?: string; path?: string };

function readJsonl(name: string): Row[] {
  try {
    return readFileSync(join(home, name), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);
  } catch {
    return [];
  }
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATCHWORK_HOME;
  // PATCHWORK_HOME, never a spy on `os.homedir` — a namespace spy misses named
  // imports and has previously let a test write to the developer's real store.
  process.env.PATCHWORK_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prev;
  }
}

describe("the shadow ledger's record level", () => {
  it("declares a record version at all", () => {
    // Without this the two assertions below pass against a module that exports
    // nothing: `SHADOW_RECORD_VERSION` is then `undefined`, `rv` is absent, and
    // `expect(undefined).toBe(undefined)` is green. A test that cannot fail is
    // the thing this whole change is about.
    expect(typeof SHADOW_RECORD_VERSION).toBe("number");
  });

  it("stamps `rv` on every row it writes", () => {
    recordPrivacyShadow(
      {
        decision: "ALLOW",
        classification: "public",
        destinationId: "d",
        destinationType: "local",
        reason: "ok",
        enforcing: false,
        correlationId: "yaml:x:1",
      },
      { dir: home },
    );
    const rows = readJsonl("privacy_shadow.jsonl");
    expect(typeof rows[0]?.rv).toBe("number");
    expect(rows[0]?.rv).toBe(SHADOW_RECORD_VERSION);
    expect(rows[0]?.correlationId).toBe("yaml:x:1");
  });

  it("omits `correlationId` rather than writing an empty one", () => {
    recordPrivacyShadow(
      {
        decision: "ALLOW",
        classification: "public",
        destinationId: "d",
        destinationType: "local",
        reason: "ok",
        enforcing: false,
      },
      { dir: home },
    );
    const rows = readJsonl("privacy_shadow.jsonl");
    // Absent, never "" or null — a reader must tell "no claim" from "claim
    // broken", and an empty string is neither.
    expect("correlationId" in (rows[0] ?? {})).toBe(false);
    expect(rows[0]?.rv).toBe(SHADOW_RECORD_VERSION);
    expect(typeof rows[0]?.rv).toBe("number");
  });
});

describe("a shadow observation names the run it observed", () => {
  it("FLAT runner: the shadow row and the RECEIPT join on one run id", async () => {
    writeConfig();
    await withHome(async () => {
      const { runYamlRecipe } = await import("../../recipes/yamlRunner.js");
      await runYamlRecipe(
        {
          name: "shadow-corr",
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

    const shadow = readJsonl("privacy_shadow.jsonl");
    const receipts = readJsonl("boundary_receipts.jsonl");
    expect(shadow.length).toBeGreaterThan(0);
    expect(receipts.length).toBeGreaterThan(0);
    for (const row of shadow) {
      expect(row.rv).toBe(SHADOW_RECORD_VERSION);
      expect(row.correlationId).toMatch(/^yaml:shadow-corr:\d+$/);
    }
    // The join. This is the whole point: one dispatch, two ledgers, one run.
    const shadowRuns = new Set(shadow.map((r) => r.correlationId));
    const receiptRuns = new Set(receipts.map((r) => r.correlationId));
    expect([...shadowRuns].some((id) => receiptRuns.has(id))).toBe(true);
  });

  it("CHAINED runner: the shadow row carries the run's taskId too", async () => {
    // The load-bearing half. The chained dep-builder is called before
    // `runChainedRecipe` computes its run id, so a fix applied to the flat path
    // alone leaves this one anonymous — the exact half-covered join the receipt
    // ledger had to avoid.
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
      const chainedDeps = buildChainedDeps(runnerDeps, undefined, "chain-corr");
      await runChainedRecipe(
        {
          name: "chain-corr",
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
        { env: {}, maxConcurrency: 1, maxDepth: 3, dryRun: false } as never,
        chainedDeps,
      );
    });
    const shadow = readJsonl("privacy_shadow.jsonl");
    expect(shadow.length).toBeGreaterThan(0);
    for (const row of shadow) {
      expect(row.rv).toBe(SHADOW_RECORD_VERSION);
      // The exact shape, not merely "truthy": the chained deps are built before
      // the run id exists, so a fix that only reached the flat path leaves this
      // path writing rows with no id while the flat test still passes.
      expect(row.correlationId).toMatch(/^chained:chain-corr:\d+$/);
    }
  });
});

describe("the orchestrator path's absence is a STATE, not a defect", () => {
  it("writes no correlationId, because there is no run to name", () => {
    // `runClaudeTask` and the automation hooks are not recipe runs and have no
    // row in `runs.jsonl`. Stamping them with something run-shaped would assert
    // a run that never existed — the same reasoning the approval ledger's
    // sentinel uses for its two runless paths. Registered NOT-APPLICABLE at
    // `rv >= 1`, and pinned here so nobody later "completes" the coverage.
    recordPrivacyShadow(
      {
        path: "orchestrator-task",
        decision: "ALLOW",
        classification: "internal",
        destinationId: "d",
        destinationType: "remote",
        reason: "ok",
        enforcing: true,
      },
      { dir: home },
    );
    const rows = readJsonl("privacy_shadow.jsonl");
    expect(rows[0]?.path).toBe("orchestrator-task");
    expect("correlationId" in (rows[0] ?? {})).toBe(false);
    // Still record-levelled: the row makes a claim about every OTHER field the
    // level registers, and dropping `rv` would make it unreadable rather than
    // honestly incomplete.
    expect(rows[0]?.rv).toBe(SHADOW_RECORD_VERSION);
  });
});
