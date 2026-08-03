/**
 * boundaryForRecipe — composition of trust resolution + prospective evaluation.
 *
 * The point of the module is that it resolves the worker and store the SAME way
 * the live gate does, so these tests focus on the composition contract rather
 * than re-testing previewActions.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { boundaryForRecipe } from "../boundaryPreview.js";
import { boundarySize } from "../previewActions.js";

let home: string;

function writeWorker(recipe: string, owns: string[]) {
  const dir = join(home, "workers");
  mkdirSync(dir, { recursive: true });
  // The loader reads `*.worker.yaml` only — a .json file is silently ignored.
  writeFileSync(
    join(dir, `${recipe}.worker.yaml`),
    [
      `id: ${recipe}-worker`,
      `name: ${recipe} worker`,
      `recipe: ${recipe}`,
      "responsibilities:",
      "  - test",
      "owns:",
      ...owns.map((o) => `  - ${o}`),
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "boundary-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const opts = () => ({
  trustOpts: { patchworkDir: home, workersDir: join(home, "workers") },
});

describe("boundaryForRecipe", () => {
  it("returns null when no worker owns the recipe", () => {
    // Distinguishable from "a worker that may do nothing", which is an EMPTY
    // boundary rather than a missing one.
    expect(boundaryForRecipe("nobody-owns-this", opts())).toBeNull();
  });

  it("computes a boundary from the worker's own ownership by default", () => {
    writeWorker("release-notes", ["fs-write"]);
    const r = boundaryForRecipe("release-notes", opts());
    expect(r).not.toBeNull();
    expect(r?.workerId).toBe("release-notes-worker");
    expect(boundarySize(r!.boundary)).toBeGreaterThan(0);
  });

  it("accepts caller-supplied candidates instead of the default", () => {
    // The seam: a scenario-specific list is supplied from outside; the generic
    // derivation is the fallback.
    writeWorker("release-notes", ["fs-write"]);
    const r = boundaryForRecipe("release-notes", {
      ...opts(),
      candidates: [{ toolName: "getGitStatus", label: "Just this one" }],
    });
    expect(boundarySize(r!.boundary)).toBe(1);
    expect(r!.boundary.mayDoNow[0]?.label).toBe("Just this one");
  });

  it("applies forbid rules to the preview", () => {
    writeWorker("release-notes", ["fs-write"]);
    const r = boundaryForRecipe("release-notes", {
      ...opts(),
      candidates: [{ toolName: "editText" }],
      forbidRules: [{ match: "fs-write", reason: "read-only workspace" }],
    });
    expect(r!.boundary.notPermitted).toHaveLength(1);
    expect(r!.boundary.mayDoNow).toHaveLength(0);
  });

  it("reports whether the boundary is actually enforced", () => {
    // With the flag off the boundary is still a correct statement of policy,
    // but nothing enforces it. Reporting that is the caller's obligation; the
    // alternative — hiding the boundary — leaves an operator with nothing.
    writeWorker("release-notes", ["fs-write"]);
    const r = boundaryForRecipe("release-notes", opts());
    expect(typeof r!.enforced).toBe("boolean");
  });

  it("still returns a boundary when the flag is off", () => {
    writeWorker("release-notes", ["fs-write"]);
    expect(boundaryForRecipe("release-notes", opts())).not.toBeNull();
  });

  it("writes nothing — no approval enqueued, no decision recorded", () => {
    writeWorker("release-notes", ["fs-write", "vcs-push"]);
    boundaryForRecipe("release-notes", opts());
    // A decision log would appear here if the preview recorded anything.
    expect(() => rmSync(join(home, "worker_gate_decisions.jsonl"))).toThrow();
  });
});
