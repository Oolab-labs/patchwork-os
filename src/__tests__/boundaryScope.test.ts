/**
 * ADR-0021 scope guard (#1397).
 *
 * The ADR's invariant used to claim ALL model-bound context passed the
 * information-boundary decision point. It never did: `ClaudeOrchestrator`
 * reaches a model by a different route and is not judged at all. A stated
 * invariant broader than its enforcement is the dangerous half — it produces
 * exactly the false confidence receipts exist to prevent — so the ADR was
 * narrowed to name the recipe agent-step path explicitly.
 *
 * This test pins that narrowing to the code, in BOTH directions:
 *
 *   - if orchestrator dispatch gains a boundary decision, the ADR section is
 *     now wrong and must be updated with it;
 *   - if the recipe path ever LOSES its decision, the coverage the ADR still
 *     claims has silently evaporated.
 *
 * The second assertion is what stops this being a test that cannot fail. A
 * one-sided "the orchestrator has no boundary" check passes just as happily
 * when the boundary has been deleted from the entire codebase.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf-8");
}

/** The call that makes a dispatch governed: it records the decision. */
const BOUNDARY_MARKERS = ["recordBoundaryDecisionFn", "evaluateBoundary"];

/**
 * Whole-identifier match, NOT `String.includes`.
 *
 * Caught by probing this guard rather than by reading it: renaming
 * `recordBoundaryDecisionFn` to `recordBoundaryDecisionFn_REMOVED` deletes the
 * call while a substring check still finds it, so the control below passed
 * against a codebase with the boundary torn out. `\b` does not match between
 * `n` and `_`, so a suffixed identifier no longer counts as present.
 */
function mentions(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(source);
}

describe("ADR-0021 scope — the boundary covers the recipe agent-step path", () => {
  it("executeAgent DOES evaluate the boundary (control)", () => {
    // Anchor. Without this the orchestrator assertion below would pass even if
    // the boundary had been removed from the codebase entirely.
    const agentExecutor = read("recipes/agentExecutor.ts");
    for (const marker of BOUNDARY_MARKERS) {
      expect(
        mentions(agentExecutor, marker),
        `agentExecutor.ts should contain "${marker}" — the recipe agent-step ` +
          "path is the coverage ADR-0021 still claims",
      ).toBe(true);
    }
  });

  it("orchestrator dispatch does NOT — and ADR-0021 says so", () => {
    const orchestrator = read("claudeOrchestrator.ts");
    for (const marker of BOUNDARY_MARKERS) {
      expect(
        mentions(orchestrator, marker),
        `claudeOrchestrator.ts contains "${marker}", so orchestrator dispatch ` +
          "is now governed. That is good — but ADR-0021's 'Scope: what the " +
          "boundary does NOT cover' section now describes something untrue " +
          "and must be updated in the same change.",
      ).toBe(false);
    }
  });

  it("orchestrator dispatch IS observed in shadow, though not enforced (#1397)", () => {
    // The pair above only says orchestrator dispatch is not GOVERNED. On its
    // own that is one-sided: deleting the shadow observation would keep it
    // passing, and the privacy report would then show zero orchestrator rows —
    // indistinguishable from a path that is simply quiet. Silence is exactly
    // what an unobserved path produces, so "observed but not enforced" has to
    // be pinned from both directions.
    const orchestrator = read("claudeOrchestrator.ts");
    // The CALL SITE, not the identifier. `mentions()` is satisfied by the
    // function's own declaration and its doc comment, so deleting the call
    // left this guard green — probed, not assumed, and it is the same trap
    // this file's header records for `recordBoundaryDecisionFn_REMOVED`.
    expect(
      /observeOrchestratorShadow\s*\(\s*this\.driver/.test(orchestrator),
      "claudeOrchestrator.ts no longer CALLS observeOrchestratorShadow at its " +
        "dispatch point, so `patchwork privacy shadow` will report 0 " +
        "orchestrator rows and read as coverage rather than absence",
    ).toBe(true);
    // And the observation must stay an OBSERVATION: `enforcing: false` is what
    // keeps the ADR's out-of-scope statement true.
    expect(orchestrator).toContain("enforcing: false");
  });

  it("the ADR documents the gap rather than leaving the invariant overbroad", () => {
    // The narrowing is the deliverable of #1397. If someone restores the
    // original wording, the code has not changed but the document has started
    // claiming coverage again.
    const adr = readFileSync(
      path.resolve(SRC, "..", "docs", "adr", "0021-information-boundary.md"),
      "utf-8",
    );
    expect(adr).toContain("Scope: what the boundary does NOT cover");
    expect(adr).toContain("Orchestrator task dispatch is out of scope");
    // The invariant itself must carry the qualifier, not just the prose below
    // it — the invariant is the line people quote.
    expect(adr).toMatch(
      /No \*\*recipe agent-step\*\* context leaves Patchwork without passing/,
    );
  });
});
