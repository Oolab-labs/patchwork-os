/**
 * `shadowGate.recommend` must agree with `decideWorkerAction`.
 *
 * ## Why this test did not exist and should have
 *
 * `previewActions` has exactly this test, and CLAUDE.md explains why in terms
 * that apply here word for word: a second copy of the decision "would drift,
 * and the failure is silent and permissive". Preview got the treatment because
 * it renders a screen. `shadowGate` never did, and it is arguably the more
 * dangerous of the two — it is what `patchwork workers shadow` and
 * `patchwork workers backtest` run, which the dogfood runbook calls the
 * primary monitoring instrument for the trust ramp.
 *
 * A monitoring instrument that disagrees with the thing it monitors does not
 * fail loudly. It reports a number, and the number is wrong.
 *
 * ## What diverged
 *
 * `shadowGate` reimplements the trust maths rather than calling the gate. It
 * has the reversibility short-circuit and the autonomy ceiling, and it is
 * missing both of the concepts added later:
 *
 *   - **`forbid`.** `decideWorkerAction` evaluates forbid rules FIRST, ahead
 *     of everything including the reversibility short-circuit, precisely
 *     because any branch that runs earlier is a path around the ban. Shadow
 *     has no notion of it — so for a forbidden REVERSIBLE action it reports
 *     `bypass`: the instrument says the ramp would let through an action that
 *     is banned outright.
 *   - **`contextCeiling`.** A live de-rater that can only lower the effective
 *     level. Shadow ignores it, so it reports `bypass` where the gate would
 *     hold.
 *
 * Both divergences run in the permissive direction, which is the direction
 * that does not get noticed.
 *
 * ## What this test does NOT do
 *
 * It does not assert the two are the same function. They answer different
 * questions — the gate returns three terminal states (`allow` / `gate` /
 * `forbid`), shadow returns two (`bypass` / `queue`) because it predates the
 * third. The mapping asserted here is the honest one:
 *
 *     gate allow  ⇒ shadow bypass
 *     gate gate   ⇒ shadow queue
 *     gate forbid ⇒ shadow MUST NOT say bypass
 *
 * A forbidden action reported as `bypass` is the failure worth failing on.
 */

import { describe, expect, it } from "vitest";
import { recommend } from "../shadowGate.js";
import type { WorkerManifest } from "../worker.js";
import { decideWorkerAction } from "../workerGate.js";
import type { WorkerLevelStore } from "../workerLevelStore.js";

/** A store returning a fixed level for everything — the variable under test
 *  is the decision logic, not the evidence maths. */
function storeAt(level: number): WorkerLevelStore {
  return {
    getState: () => ({ level, alpha: 1, beta: 1, outcomes: [] }),
  } as unknown as WorkerLevelStore;
}

const worker = (over: Partial<WorkerManifest> = {}): WorkerManifest =>
  ({
    id: "w1",
    name: "test-worker",
    owns: ["issue", "fs-write", "other"],
    autonomyCeiling: 4,
    ...over,
  }) as WorkerManifest;

/** Tools spanning the three reversibility classes. */
/**
 * Real classifications, read from `classifyActionClass` rather than assumed —
 * the first draft of this test guessed the domains and the forbid rule matched
 * nothing, so the case it existed to cover never ran.
 */
const TOOLS: Array<[string, Record<string, unknown> | undefined]> = [
  ["github.search_issues", undefined], // other:irreversible:low
  ["github.create_issue", { title: "x" }], // issue:compensable:high
  ["git.push", { branch: "main" }], // other:irreversible:medium
  ["file.write", { path: "notes/example.md", content: "y" }], // fs-write:REVERSIBLE:medium
];

const LEVELS = [0, 1, 2, 3, 4];
const CEILINGS = [0, 2, 4];

describe("shadowGate agrees with the live gate", () => {
  it("maps allow/gate identically across levels, ceilings and tools", () => {
    const mismatches: string[] = [];
    for (const level of LEVELS) {
      for (const ceiling of CEILINGS) {
        const w = worker({ autonomyCeiling: ceiling as never });
        const store = storeAt(level);
        for (const [tool, params] of TOOLS) {
          const live = decideWorkerAction(w, tool, params, store);
          const shadow = recommend(w, tool, params, store);
          const expected = live.action === "allow" ? "bypass" : "queue";
          if (shadow.decision !== expected) {
            mismatches.push(
              `${tool} L${level}/C${ceiling}: gate=${live.action} shadow=${shadow.decision}`,
            );
          }
        }
      }
    }
    expect(mismatches, `divergences:\n  ${mismatches.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("NEVER reports bypass for an action the gate forbids", () => {
    // The sharpest case: a forbidden REVERSIBLE action. Shadow's first branch
    // short-circuits on reversibility and returns bypass without ever looking
    // at a forbid rule, so the monitoring output says the ramp would let
    // through something that is banned outright.
    const w = worker();
    const store = storeAt(4);
    // `fs-write` is REVERSIBLE, which is the whole point: shadow returns
    // bypass from its first branch without ever consulting a forbid rule.
    const forbidRules = [
      { match: "fs-write", reason: "banned in this test" },
    ] as const;
    const forbidden: string[] = [];
    const mismatches: string[] = [];
    for (const [tool, params] of TOOLS) {
      const opts = { forbidRules } as never;
      const live = decideWorkerAction(w, tool, params, store, opts);
      if (live.action !== "forbid") continue;
      forbidden.push(tool);
      const shadow = recommend(w, tool, params, store, opts);
      if (shadow.decision === "bypass") {
        mismatches.push(`${tool}: gate=forbid shadow=bypass`);
      }
    }
    // Without this the test passes by never entering the loop — which is
    // exactly how its first draft passed while proving nothing.
    expect(
      forbidden.length,
      "no action was forbidden — the case never ran",
    ).toBeGreaterThan(0);
    expect(
      mismatches,
      `forbidden actions reported as bypass:\n  ${mismatches.join("\n  ")}`,
    ).toEqual([]);
  });

  it("does not report bypass when a context ceiling de-rates the gate", () => {
    // contextRisk can only LOWER the effective level. Shadow ignores it, so it
    // reports the un-throttled answer while the gate holds.
    const w = worker();
    const store = storeAt(4);
    const mismatches: string[] = [];
    for (const [tool, params] of TOOLS) {
      const opts = { contextRisk: { score: 0.95 } } as never;
      const live = decideWorkerAction(w, tool, params, store, opts);
      const shadow = recommend(w, tool, params, store, opts);
      const expected = live.action === "allow" ? "bypass" : "queue";
      if (shadow.decision !== expected) {
        mismatches.push(
          `${tool}: gate=${live.action} shadow=${shadow.decision}`,
        );
      }
    }
    expect(
      mismatches,
      `context-ceiling divergences:\n  ${mismatches.join("\n  ")}`,
    ).toEqual([]);
  });

  it("honours the worker's OWN forbids with no opts passed", () => {
    // The case that makes the delegation matter in production. Neither
    // `workers shadow` nor `workers backtest` passes opts, so if the rules
    // were not derived from the manifest the instrument would go on reporting
    // a banned action as one the ramp would let through — which is what it
    // did.
    const w = worker({
      forbids: [{ match: "fs-write", reason: "declared on the manifest" }],
    } as never);
    const shadow = recommend(
      w,
      "file.write",
      { path: "notes/example.md", content: "y" },
      storeAt(4),
    );
    expect(shadow.forbidden).toBe(true);
    expect(shadow.decision).toBe("queue");
  });

  it("still bypasses a reversible action the manifest does NOT forbid", () => {
    // The other direction, so the fallback cannot be "forbid everything".
    const w = worker({
      forbids: [{ match: "payments", reason: "unrelated" }],
    } as never);
    const shadow = recommend(
      w,
      "file.write",
      { path: "notes/example.md", content: "y" },
      storeAt(0),
    );
    expect(shadow.forbidden).toBe(false);
    expect(shadow.decision).toBe("bypass");
  });
});
