/**
 * Every way a worker manifest can be present and govern NOTHING.
 *
 * All of these end the same way: `resolveWorkerIdForRecipe` returns undefined,
 * the caller falls back to the tier-based approval fn, and the worker ramp
 * never runs. Because the worker gate is composed as a FLOOR over the tier fn —
 * it can only ADD approvals — losing it means the recipe is governed LESS. The
 * sharpest case is a manifest's ADR-0017 `forbids` list, whose whole point is
 * that no trust and no approval unlocks the action, going inert without a word.
 *
 * Verified against the real installation before this existed: all 8 manifests
 * parsed, none dangling, none ambiguous, no drift. So these tests build the
 * broken states deliberately — a validator that has only ever seen healthy
 * input is not known to be able to fail.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatWorkersValidate,
  scanWorkers,
  validateWorkers,
} from "../workersCli.js";

let workersDir: string;
let recipesDir: string;

beforeEach(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pw-workers-cli-"));
  workersDir = path.join(root, "workers");
  recipesDir = path.join(root, "recipes");
  for (const d of [workersDir, recipesDir]) mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(recipesDir, "good.yaml"),
    "name: good-recipe\ndescription: d\ntrigger: { type: manual }\nsteps: []\n",
  );
});
afterEach(() => {
  rmSync(path.dirname(workersDir), { recursive: true, force: true });
});

function worker(file: string, body: string) {
  writeFileSync(path.join(workersDir, file), body);
}

const healthy = `id: healthy-worker
name: Healthy
responsibilities: [x]
recipe: good-recipe
owns: [issue]
autonomyCeiling: 1
`;

function validate() {
  return validateWorkers({ workersDir, recipesDir });
}

describe("scanWorkers keeps what the loader drops", () => {
  it("reports an unparseable manifest instead of discarding it", () => {
    worker("healthy.worker.yaml", healthy);
    worker("broken.worker.yaml", "id: [not a worker\n");
    const scan = scanWorkers(workersDir);
    expect(scan.loaded).toHaveLength(1);
    expect(scan.broken).toHaveLength(1);
    expect(scan.broken[0]?.file).toBe("broken.worker.yaml");
  });

  it("a missing directory is empty, not a throw", () => {
    const scan = scanWorkers(path.join(workersDir, "nope"));
    expect(scan.loaded).toEqual([]);
    expect(scan.broken).toEqual([]);
  });
});

describe("validateWorkers", () => {
  it("is healthy on a correct installation", () => {
    worker("healthy.worker.yaml", healthy);
    const r = validate();
    expect(r.healthy).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("errors on a manifest the bridge would silently skip", () => {
    worker("broken.worker.yaml", "id: [not a worker\n");
    const r = validate();
    expect(r.healthy).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("unparseable-manifest");
  });

  it("errors on a recipe reference that is not installed", () => {
    worker(
      "dangling.worker.yaml",
      healthy.replace("recipe: good-recipe", "recipe: not-installed"),
    );
    const r = validate();
    expect(r.findings.map((f) => f.code)).toContain("dangling-recipe");
    expect(r.healthy).toBe(false);
  });

  /**
   * BOTH are ignored, not one winner — resolution refuses to guess, because
   * guessing would apply the wrong worker's policy. The message has to say so:
   * an operator who believes one of them won will look for the wrong behaviour.
   */
  it("errors when two workers claim one recipe, and says both lose", () => {
    worker("a.worker.yaml", healthy.replace("healthy-worker", "dup-a"));
    worker("b.worker.yaml", healthy.replace("healthy-worker", "dup-b"));
    const r = validate();
    const f = r.findings.find((x) => x.code === "ambiguous-recipe");
    expect(f).toBeDefined();
    expect(f?.message).toContain("ALL of them are ignored");
  });

  it("errors on an unparseable forbids entry, because it fails OPEN", () => {
    worker("bad.worker.yaml", `${healthy}forbids:\n  - 12345\n`);
    const r = validate();
    const f = r.findings.find((x) => x.code === "unparseable-forbid-rule");
    expect(f).toBeDefined();
    expect(f?.level).toBe("error");
    expect(f?.message).toContain("fails OPEN");
  });

  it("a well-formed forbids list is not a finding", () => {
    worker(
      "ok.worker.yaml",
      `${healthy}forbids:\n  - match: payments\n    reason: never\n`,
    );
    expect(validate().healthy).toBe(true);
  });

  it("warns — not errors — when a worker declares no recipe", () => {
    worker(
      "norecipe.worker.yaml",
      healthy.replace("recipe: good-recipe\n", ""),
    );
    const r = validate();
    const f = r.findings.find((x) => x.code === "no-recipe");
    expect(f?.level).toBe("warning");
    expect(r.healthy).toBe(true);
  });

  /**
   * If no recipes are installed at all, EVERY worker would look dangling. That
   * is a statement about the recipe directory, not about the workers, and
   * emitting it per-worker would bury any real finding.
   */
  it("does not report every worker as dangling when no recipes are installed", () => {
    rmSync(path.join(recipesDir, "good.yaml"));
    worker("healthy.worker.yaml", healthy);
    expect(validate().findings.some((f) => f.code === "dangling-recipe")).toBe(
      false,
    );
  });
});

describe("the report leads with the denominator", () => {
  it("an empty install says 'nothing to check', never 'no problems'", () => {
    const out = formatWorkersValidate(validate());
    expect(out).toContain("nothing to check");
    expect(out).not.toContain("no problems");
  });

  it("a populated healthy install says no problems, with the count", () => {
    worker("healthy.worker.yaml", healthy);
    const out = formatWorkersValidate(validate());
    expect(out).toContain("1 manifest(s) load, 0 ignored");
    expect(out).toContain("no problems");
  });
});
