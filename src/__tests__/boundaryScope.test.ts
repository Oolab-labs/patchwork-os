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

  it("orchestrator dispatch DOES too, since the 2026-08-30 amendment", () => {
    // INVERTED. This assertion used to require the ABSENCE of a boundary here,
    // pinning ADR-0021's out-of-scope statement to the code. The amendment
    // built the precondition that statement named, so the guard flips with it:
    // the thing that must not silently change is no longer "this path is
    // ungoverned" but "this path is governed, on an operator's path-level
    // default".
    //
    // The direction matters more than the assertion. A guard that had simply
    // been DELETED when enforcement landed would have left the path unpinned in
    // both directions — free to lose its boundary again with nothing failing.
    const orchestrator = read("claudeOrchestrator.ts");
    expect(
      mentions(orchestrator, "governOrchestratorDispatch"),
      "claudeOrchestrator.ts no longer declares governOrchestratorDispatch, " +
        "so orchestrator dispatch is ungoverned again and ADR-0021's " +
        "amendment describes something untrue.",
    ).toBe(true);
    // The CALL SITE, not just the declaration — the same trap this file's
    // header records, and the one that left the shadow guard green with the
    // observation deleted.
    expect(
      /governOrchestratorDispatch\s*\(\s*\n?\s*this\.driver/.test(orchestrator),
      "claudeOrchestrator.ts declares governOrchestratorDispatch but no longer " +
        "CALLS it at its dispatch point, so every orchestrator task flows " +
        "unjudged while the ADR says the path is enforced",
    ).toBe(true);
    // And it must be able to REFUSE. An enforcement that computes a decision
    // and never acts on it is the fail-open this whole ADR exists to prevent,
    // and it looks identical from the outside to one that always allows.
    expect(
      mentions(orchestrator, "InformationBoundaryRefusal"),
      "claudeOrchestrator.ts can no longer refuse a dispatch — the boundary " +
        "decision is computed and discarded",
    ).toBe(true);
  });

  it("orchestrator dispatch IS observed in shadow, alongside enforcement", () => {
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
    // The observation must stay an OBSERVATION — but `enforcing` is no longer
    // hardcoded. It reports whether a live policy WAS enforcing, which on this
    // path is now sometimes true, so pinning the literal `false` would pin a
    // lie. What must hold is that the shadow row still cannot refuse anything:
    // `recordPrivacyShadow` is the only thing it calls, and the refusal lives
    // in the other function entirely.
    expect(orchestrator).toContain(
      "enforcing: pathClassification !== undefined",
    );
    // Observation BEFORE enforcement. Reversed, every refused dispatch would go
    // unobserved — dropping from the shadow report exactly the traffic a
    // candidate policy is being evaluated against.
    //
    // Anchored on `this.driver`, i.e. the CALL, not the identifier. A first
    // attempt used plain `indexOf` on the bare name and compared the two
    // FUNCTION DECLARATIONS instead — which sit in the opposite order and never
    // move — so it passed against a deliberately swapped call site. Found by
    // making that swap and watching the guard stay green, not by reading it.
    const callOf = (name: string) =>
      orchestrator.search(new RegExp(`${name}\\(\\s*\\n\\s*this\\.driver`));
    const observeAt = callOf("observeOrchestratorShadow");
    const governAt = callOf("governOrchestratorDispatch");
    expect(observeAt).toBeGreaterThan(-1);
    expect(governAt).toBeGreaterThan(-1);
    expect(
      observeAt < governAt,
      "enforcement now runs before observation, so refused dispatches are " +
        "never recorded in the shadow ledger",
    ).toBe(true);
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
    // The original scope section stays. It is superseded, not deleted: the
    // reasoning it records is why the amendment took the shape it did, and a
    // reader who finds only the outcome cannot tell which alternatives were
    // rejected or why.
    expect(adr).toContain(
      "Amendment 2026-08-30 — orchestrator enforcement, on a path-level default",
    );
    // The invariant itself must carry the qualifier, not just the prose below
    // it — the invariant is the line people quote. It now names both paths AND
    // the condition on the second; an unconditional claim here would be the
    // overbroad invariant this ADR already had to correct once.
    expect(adr).toMatch(
      /No \*\*recipe agent-step\*\* context leaves Patchwork without passing/,
    );
    expect(adr).toMatch(
      /once `privacy\.orchestrator` is\s*\n?> ?configured, no \*\*orchestrator task\*\* does either/,
    );
  });
});
