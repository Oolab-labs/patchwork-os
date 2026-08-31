/**
 * The `patchwork-os/gate` seam: does it exist, and is it still a pass-through?
 *
 * Two different failures are guarded here and they fail in opposite ways.
 *
 * The export map is the one that fails INVISIBLY. `dist/gate.js` is published
 * whatever happens — `files` carries `dist` wholesale — so deleting the
 * `"./gate"` entry breaks every consumer while leaving the built artifact
 * sitting in the tarball looking present. Nothing else in this repository
 * imports through the package name, so no other test would notice.
 *
 * The pass-through is the one that fails PERMISSIVELY. A barrel that starts
 * adapting its re-exports is the second implementation of the boundary that
 * `previewActions` exists to prevent, sited in the file that looks most like
 * plumbing and least like policy. Reference identity is the only assertion
 * that catches it, because a wrapper with correct behaviour today passes every
 * behavioural test and drifts next quarter.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as gate from "../gate.js";
import * as actionClass from "../workers/actionClass.js";
import * as forbidPolicy from "../workers/forbidPolicy.js";
import * as previewActions from "../workers/previewActions.js";
import * as trustLevel from "../workers/trustLevel.js";
import * as worker from "../workers/worker.js";
import * as workerGate from "../workers/workerGate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, "..", "..", "package.json"), "utf8"),
) as {
  files: string[];
  exports: Record<string, { import: string; types: string }>;
};

describe("the ./gate subpath export", () => {
  it("is declared in the export map", () => {
    // Without this entry Node refuses the specifier outright
    // (ERR_PACKAGE_PATH_NOT_EXPORTED), and the package root is no fallback:
    // `main` and `bin` are the same file, so importing it runs the CLI.
    expect(pkg.exports["./gate"]).toEqual({
      import: "./dist/gate.js",
      types: "./dist/gate.d.ts",
    });
  });

  it("points at a path the tarball actually carries", () => {
    // `files` governs npm packaging and git exclusions have no effect on it.
    // An export naming a path outside `files` resolves locally and 404s for
    // every installer — the failure that only reproduces after publish.
    expect(pkg.files).toContain("dist");
    for (const negated of pkg.files.filter((f) => f.startsWith("!"))) {
      expect(pkg.exports["./gate"].import.slice(2)).not.toMatch(
        new RegExp(`^${negated.slice(1).replace(/\*\*?/g, ".*")}$`),
      );
    }
  });
});

describe("the barrel is a pass-through, not an implementation", () => {
  // Only value bindings can be compared by identity; types erase at runtime.
  const sources: Array<[string, Record<string, unknown>]> = [
    ["workerGate", workerGate],
    ["previewActions", previewActions],
    ["actionClass", actionClass],
    ["worker", worker],
    ["trustLevel", trustLevel],
    ["forbidPolicy", forbidPolicy],
  ];

  it("re-exports the identical symbol, never a wrapper", () => {
    const checked: string[] = [];
    for (const [name, mod] of sources) {
      for (const [key, value] of Object.entries(mod)) {
        if (!Object.hasOwn(gate, key)) continue;
        expect(
          (gate as Record<string, unknown>)[key],
          `${name}.${key} is re-exported by gate.ts as a different value — a ` +
            "barrel that adapts is the second implementation previewActions exists to prevent",
        ).toBe(value);
        checked.push(key);
      }
    }
    // A pass-through test that compared nothing would pass on an empty barrel.
    expect(checked.length).toBeGreaterThan(20);
  });

  it("carries the surface a boundary consumer cannot work without", () => {
    // Each of these is load-bearing for rendering the three columns and saying
    // WHY an action landed in one. Dropping any of them sends the consumer
    // back to re-deriving the answer from ledger rows.
    for (const required of [
      "previewActions",
      "defaultCandidatesFor",
      "decideWorkerAction",
      "resolveGateOutcome",
      "gateOutcomeFor",
      "classifyActionClass",
      "parseForbidRules",
      "parseWorker",
      "loadWorkersFromDir",
      "WorkerLevelStore",
      "levelFromPosterior",
      "contextRiskCeiling",
      "coversAction",
      "GATE_POLICY_VERSION",
    ]) {
      expect(
        Object.hasOwn(gate, required),
        `gate.ts no longer exports ${required}`,
      ).toBe(true);
    }
  });
});
