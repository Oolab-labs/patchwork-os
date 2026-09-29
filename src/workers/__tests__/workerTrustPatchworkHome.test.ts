/**
 * Worker trust must be read from PATCHWORK_HOME, like every other ledger.
 *
 * `runWorkerShadow.ts` defaulted its home to `os.homedir()/.patchwork` in four
 * functions — the worker gate's trust loader, `workers shadow`, `workers
 * backtest` and the pending-confirmations list — while the outcome log inside
 * the same trust load used `patchworkHome()`. With PATCHWORK_HOME set, a trust
 * load read workers and runs from one home and outcomes from another.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkerTrustForRecipe,
  runWorkerBacktest,
} from "../runWorkerShadow.js";

// A name no real ~/.patchwork on a developer machine will carry.
const RECIPE = "trust-home-example-recipe";
const WORKER = "trust-home-example-worker";

let home: string;
let saved: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-trust-home-"));
  mkdirSync(path.join(home, "workers"), { recursive: true });
  writeFileSync(
    path.join(home, "workers", "example.worker.yaml"),
    `id: ${WORKER}\nname: Example\nrecipe: ${RECIPE}\nowns:\n  - fs-write\nautonomyCeiling: 4\n`,
  );
  saved = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("worker trust honours PATCHWORK_HOME", () => {
  it("the gate's trust loader finds the worker in PATCHWORK_HOME", () => {
    const trust = loadWorkerTrustForRecipe(RECIPE);
    expect(trust?.worker.id).toBe(WORKER);
  });

  it("workers backtest reads PATCHWORK_HOME", () => {
    expect(runWorkerBacktest()).toContain(WORKER);
  });

  it("no function in runWorkerShadow.ts builds the home from os.homedir()", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "runWorkerShadow.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/path\.join\(\s*home\s*,\s*"\.patchwork"\s*\)/);
  });
});
