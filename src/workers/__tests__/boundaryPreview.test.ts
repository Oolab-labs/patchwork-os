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

function writeWorker(recipe: string, owns: string[], forbidsYaml?: string[]) {
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
      ...(forbidsYaml ?? []),
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
    expect(typeof r!.autonomyFlagEnabled).toBe("boolean");
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

describe("boundaryForRecipe — forbid rules from the worker manifest", () => {
  // Before this, `forbidRules` was threaded through every type but no
  // production code ever supplied one — only tests did. The "not permitted"
  // column was therefore structurally always empty in the running product:
  // the policy existed with no configuration surface.
  const FORBIDS = [
    "forbids:",
    "  - match: messaging",
    "    reason: May never communicate externally on its own account.",
  ];

  it("reads forbids from the manifest so the third column can be non-empty", () => {
    writeWorker("close-review", ["fs-write", "messaging"], FORBIDS);
    const r = boundaryForRecipe("close-review", opts());
    expect(r).not.toBeNull();
    expect(r!.boundary.notPermitted.length).toBeGreaterThan(0);
    // The operator's own words reach the screen — "denied by policy" tells a
    // person nothing about which policy or why.
    expect(r!.boundary.notPermitted[0]?.reason).toContain(
      "May never communicate externally",
    );
  });

  it("an explicit caller rule set still wins over the manifest", () => {
    writeWorker("close-review", ["fs-write", "messaging"], FORBIDS);
    const r = boundaryForRecipe("close-review", {
      ...opts(),
      forbidRules: [],
    });
    // Caller passed an empty list deliberately — the manifest must not
    // silently re-add its own rules underneath it.
    expect(r!.boundary.notPermitted).toHaveLength(0);
  });

  it("a manifest with no forbids forbids nothing (opt-in)", () => {
    writeWorker("close-review", ["fs-write", "messaging"]);
    const r = boundaryForRecipe("close-review", opts());
    expect(r!.boundary.notPermitted).toHaveLength(0);
  });

  it("reports an unparseable rule rather than silently narrowing the column", () => {
    // A dropped deny rule fails OPEN — the banned action degrades to merely
    // gated. If the count were swallowed, a typo would quietly widen authority
    // and the screen would look authoritative while understating the policy.
    writeWorker(
      "close-review",
      ["fs-write", "messaging"],
      [
        "forbids:",
        "  - match: messaging",
        "    reason: fine",
        "  - match: http", // no `reason:` — unparseable
      ],
    );
    const r = boundaryForRecipe("close-review", opts());
    expect(r!.invalidForbidRules).toBe(1);
  });

  it("reports nothing when every rule parses", () => {
    writeWorker("close-review", ["fs-write", "messaging"], FORBIDS);
    expect(
      boundaryForRecipe("close-review", opts())!.invalidForbidRules,
    ).toBeUndefined();
  });

  it("a malformed forbid entry does not take the whole worker down", () => {
    // Throwing in parseWorker would skip the manifest via loadWorkersFromDir's
    // fail-soft catch — removing the worker AND its gate, so a typo in a deny
    // rule would disable the policy it was tightening. The rule is dropped and
    // reported by parseForbidRules instead; the worker survives.
    writeWorker(
      "close-review",
      ["fs-write", "messaging"],
      [
        "forbids:",
        "  - match: messaging", // no `reason:` — unparseable
      ],
    );
    const r = boundaryForRecipe("close-review", opts());
    expect(r).not.toBeNull();
    expect(boundarySize(r!.boundary)).toBeGreaterThan(0);
  });
});
