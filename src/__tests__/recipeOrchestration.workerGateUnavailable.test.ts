/**
 * The worker gate must not fail OPEN when it cannot be built.
 *
 * Audit 2026-10-15 (M1): `buildWorkerAutonomyGate` ended in `catch { return
 * null }` with a comment saying "never widen access". Null means "no worker
 * gate": the caller falls back to the tier fn alone, and the worker's
 * `forbids` and ramp are off for that run with no log. That IS widening.
 *
 * Governed: a failure to build the gate refuses the run with a named error.
 * Compat: today's fallback, but said out loud.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/runWorkerShadow.js", () => ({
  loadWorkerTrustForRecipe: () => {
    throw new Error("checkpoint exploded");
  },
}));

import { FLAG_WORKER_AUTONOMY, setFlag } from "../featureFlags.js";
import { resolveProfile, setActiveProfile } from "../governance/profile.js";
import {
  buildWorkerAgentDisallowedTools,
  buildWorkerAutonomyGate,
  WorkerGateUnavailableError,
} from "../recipeOrchestration.js";

let dir: string;
let opts: { workersDir: string; patchworkDir: string };
const warnings: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-wgate-unavail-"));
  const workersDir = path.join(dir, "workers");
  mkdirSync(workersDir, { recursive: true });
  writeFileSync(
    path.join(workersDir, "t.worker.yaml"),
    "id: t\nname: T\nrecipe: test-recipe\nowns: [fs-write]\nautonomyCeiling: 4\n",
  );
  opts = { workersDir, patchworkDir: dir };
  warnings.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  setFlag(FLAG_WORKER_AUTONOMY, false, false);
  setActiveProfile(resolveProfile({ profile: "compat" }));
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildWorkerAutonomyGate when trust cannot be loaded", () => {
  it("GOVERNED: refuses with worker_gate_unavailable instead of returning null", async () => {
    setActiveProfile(resolveProfile({ profile: "governed" }));
    await expect(
      buildWorkerAutonomyGate("test-recipe", undefined, opts),
    ).rejects.toBeInstanceOf(WorkerGateUnavailableError);
    await expect(
      buildWorkerAutonomyGate("test-recipe", undefined, opts),
    ).rejects.toMatchObject({ code: "worker_gate_unavailable" });
  });

  it("COMPAT (flag on): falls back to the tier fn but says so", async () => {
    setActiveProfile(resolveProfile({ profile: "compat" }));
    setFlag(FLAG_WORKER_AUTONOMY, true, false);
    const g = await buildWorkerAutonomyGate("test-recipe", undefined, opts);
    expect(g).toBeNull();
    expect(warnings.join("\n")).toContain("worker gate");
    expect(warnings.join("\n")).toContain("test-recipe");
  });

  it("the agent disallowed-tools builder follows the same rule", async () => {
    setActiveProfile(resolveProfile({ profile: "governed" }));
    await expect(
      buildWorkerAgentDisallowedTools("test-recipe", opts),
    ).rejects.toMatchObject({ code: "worker_gate_unavailable" });
  });
});
