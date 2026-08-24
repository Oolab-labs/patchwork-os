/**
 * Guard: a worker must not be able to CONFIRM ITS OWN FILINGS.
 *
 * The property is real and currently holds. What is wrong is the reason
 * CLAUDE.md gives for it — that `outcomes confirm|reject` "is NOT a recipe
 * step". `outcomes.classify_issues` IS a recipe step and it also writes
 * dispositions to `OutcomeStore`, so the CLI-only path is not what secures
 * anything.
 *
 * What actually secures it is a chain of three facts, and only the second is
 * an ABSENCE that nothing else defends:
 *
 *   1. `classifyIssueDisposition` is a pure function of the issue's own GitHub
 *      state — labels, `state`, `state_reason`. The worker asserts nothing; the
 *      LLM judge that used to freehand this was removed for non-determinism.
 *   2. No recipe-facing `github.*` tool can MUTATE that state. The surface is
 *      create + read only. ← this file
 *   3. The generic escape hatches are closed: `http.post` cannot resolve
 *      connector tokens, and `{{env.X}}` only exposes keys a recipe explicitly
 *      declares in a `context: env` block.
 *
 * Break (2) and a worker files an issue, closes it as completed (or labels it
 * `confirmed`), and `outcomes.classify_issues` records `confirmed` for it. The
 * worker then climbs the trust ramp on evidence it manufactured — trust-by-
 * neglect, which is the exact failure the outcome gate exists to prevent, and
 * the one #1318/#1319/#1320/#1322 each closed a different door on.
 *
 * Adding `github.close_issue` or `github.add_label` is an obviously reasonable
 * feature request. Nothing in the codebase would have objected before this
 * file, and CLAUDE.md's stated reasoning points at the wrong mechanism, so a
 * reviewer checking it would have concluded the change was safe.
 */

import { describe, expect, it } from "vitest";
import { classifyIssueDisposition } from "../../../workers/outcomeStore.js";
import { listTools } from "../../toolRegistry.js";

// Importing the module self-registers the tools into the shared registry.
import "../github.js";

/**
 * Every `github.*` tool a recipe may call today. Create + read only.
 *
 * `create_issue` is safe here on purpose: filing an issue is the ACTION being
 * judged, not the judgement. It produces an open, unlabelled issue, which
 * `classifyIssueDisposition` maps to `unknown` — and an `unknown` filing is
 * withheld, never earning trust.
 */
const READ_AND_CREATE_ONLY = new Set([
  "github.create_issue",
  "github.list_commits",
  "github.list_issues",
  "github.list_prs",
  "github.search_issues",
]);

/**
 * Verbs that could manufacture a `confirmed` disposition, by either route the
 * classifier accepts. Kept as substrings rather than exact ids so a differently
 * named twin (`github.edit_issue`, `github.set_labels`) is caught too.
 */
const STATE_MUTATING_VERBS = [
  "close",
  "reopen",
  "label",
  "update",
  "edit",
  "patch",
  "set_state",
  "comment",
];

describe("guard — no recipe-facing GitHub tool can mutate issue state", () => {
  it("registers only create + read tools", () => {
    const unexpected = listTools("github")
      .map((t) => t.id)
      .filter((id) => !READ_AND_CREATE_ONLY.has(id))
      .sort();

    // Deliberately an exact-membership check rather than a pattern match. A
    // pattern only catches the hazards someone already thought of; this catches
    // ANY addition and makes the author come here and argue for it.
    //
    // If the new tool genuinely cannot change an issue's state, labels or
    // state_reason, add it to READ_AND_CREATE_ONLY. If it can, it breaks the
    // self-confirmation invariant described at the top of this file and needs a
    // different design — the operator path (`outcomes confirm|reject`) exists
    // precisely so a human, not the worker, supplies that signal.
    expect(unexpected).toEqual([]);
  });

  it("registers no tool whose name suggests it changes issue state", () => {
    const offenders = listTools("github")
      .map((t) => t.id)
      .filter((id) =>
        STATE_MUTATING_VERBS.some((verb) => id.toLowerCase().includes(verb)),
      )
      .sort();

    // Defence in depth: this still fires if someone widens the allowlist above
    // without reading why it is narrow.
    expect(offenders).toEqual([]);
  });
});

describe("guard — the two signals that earn `confirmed`", () => {
  // Pins the rationale. If the classifier ever accepts a third signal, the
  // reasoning above is incomplete and the allowlist may no longer be sufficient.

  it("treats close-as-completed as confirmed", () => {
    expect(
      classifyIssueDisposition({ state: "closed", state_reason: "completed" }),
    ).toBe("confirmed");
  });

  it("treats a confirming label as confirmed", () => {
    expect(classifyIssueDisposition({ labels: ["confirmed"] })).toBe(
      "confirmed",
    );
  });

  it("treats a freshly filed issue as unknown, so filing alone earns nothing", () => {
    expect(classifyIssueDisposition({ state: "open", labels: [] })).toBe(
      "unknown",
    );
  });
});
