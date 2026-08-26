/**
 * Two things this file guards, both learned the same way.
 *
 * 1. A run that violated its RUN-LEVEL completion contract must appear in the
 *    halt count. Such a run finishes `done`, not `error`, so the run-level
 *    branch never fired and `HaltSummaryInputRun` had no field for
 *    `assertionFailures` at all — "nothing halted" and "the job did not do
 *    what it promised" read identically.
 *
 * 2. The bridge's `HaltCategory` and the dashboard's copy must agree. They had
 *    already drifted before this file existed: `judge_revisions_exhausted`
 *    shipped in the bridge and was absent from the dashboard entirely, so a
 *    run halted by an exhausted judge loop rendered with no label and no fix
 *    hint. Nothing caught it, because a `Record<HaltCategory, string>` on a
 *    SHORTER union is perfectly well-typed — the drift is invisible to both
 *    compilers by construction. It has to be checked as text.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HALT_CATEGORY_HINTS,
  HALT_CATEGORY_LABELS,
  type HaltSummaryInputRun,
  summariseHalts,
} from "../haltCategory.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function unionMembers(file: string): string[] {
  const src = readFileSync(path.join(repoRoot, file), "utf8");
  const m = /export type HaltCategory\s*=(.*?);/s.exec(src);
  if (!m) throw new Error(`no HaltCategory union found in ${file}`);
  return (m[1] as string)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\|\s*"|"$/g, ""));
}

function run(over: Partial<HaltSummaryInputRun> = {}): HaltSummaryInputRun {
  return { seq: 1, status: "done", ...over };
}

describe("completion-contract failures are visible to halts", () => {
  it("counts a done run that broke its run-level expect", () => {
    const s = summariseHalts([
      run({ assertionFailures: [{ message: "missing SUMMARY" }] }),
    ]);
    expect(s.total).toBe(1);
    expect(s.byCategory.contract_failed).toBe(1);
    expect(s.recent[0]?.category).toBe("contract_failed");
  });

  it("counts ONE entry per run, not one per assertion", () => {
    const s = summariseHalts([run({ assertionFailures: [{}, {}, {}] })]);
    expect(s.byCategory.contract_failed).toBe(1);
    expect(s.total).toBe(1);
    expect(s.recent[0]?.reason).toContain("3 assertions");
  });

  it("says 'assertion' singular for one failure", () => {
    const s = summariseHalts([run({ assertionFailures: [{}] })]);
    expect(s.recent[0]?.reason).toContain("1 assertion)");
  });

  it("a clean done run still contributes nothing", () => {
    const s = summariseHalts([run(), run({ assertionFailures: [] })]);
    expect(s.total).toBe(0);
    expect(s.byCategory.contract_failed).toBeUndefined();
  });

  /**
   * Deliberately NOT guarded on the step count, unlike `run_level`: a step
   * failing and a postcondition being violated are different facts, and a run
   * can have either without the other.
   */
  it("counts alongside step halts rather than instead of them", () => {
    const s = summariseHalts([
      run({
        status: "error",
        stepResults: [{ status: "error", haltReason: "Tool x threw" }],
        assertionFailures: [{}],
      }),
    ]);
    expect(s.byCategory.contract_failed).toBe(1);
    expect(s.byCategory.tool_threw).toBe(1);
    expect(s.total).toBe(2);
  });

  it("does not quote the assertion text into `recent`", () => {
    // The assertion can carry run output, and `recent` reaches the CLI, the
    // dashboard and a metrics-adjacent surface.
    const s = summariseHalts([
      run({ assertionFailures: [{ message: "SECRET-PAYLOAD-MARKER" }] }),
    ]);
    expect(JSON.stringify(s)).not.toContain("SECRET-PAYLOAD-MARKER");
  });
});

describe("bridge and dashboard halt categories agree", () => {
  const bridge = unionMembers("src/recipes/haltCategory.ts");
  const dash = unionMembers("dashboard/src/lib/haltCategory.ts");

  it("the unions hold exactly the same members", () => {
    expect([...dash].sort()).toEqual([...bridge].sort());
  });

  it("every bridge category has a label and a hint", () => {
    for (const c of bridge) {
      expect(
        HALT_CATEGORY_LABELS[c as keyof typeof HALT_CATEGORY_LABELS],
      ).toBeTruthy();
      expect(
        HALT_CATEGORY_HINTS[c as keyof typeof HALT_CATEGORY_HINTS],
      ).toBeTruthy();
    }
  });

  it("every dashboard category has a label and a hint there too", () => {
    const src = readFileSync(
      path.join(repoRoot, "dashboard/src/lib/haltCategory.ts"),
      "utf8",
    );
    // Both maps are object literals keyed by the category name; a missing key
    // is what drift looks like on that side.
    // Named SINGULAR on the dashboard side and PLURAL on the bridge side.
    // Matching the wrong one silently yields "", turning every assertion
    // below into a confusing failure about the first category rather than
    // about the missing map. Throw instead of defaulting.
    const body = (re: RegExp, what: string): string => {
      const m = re.exec(src);
      if (!m?.[1]) throw new Error(`dashboard ${what} map not found`);
      return m[1];
    };
    const labels = body(/HALT_CATEGORY_LABEL\b[^{]*\{(.*?)\n\};/s, "label");
    const hints = body(/HALT_CATEGORY_HINT\b[^{]*\{(.*?)\n\};/s, "hint");
    for (const c of dash) {
      expect(labels, `label missing for ${c}`).toContain(`${c}:`);
      expect(hints, `hint missing for ${c}`).toContain(`${c}:`);
    }
  });
});
