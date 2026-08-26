/**
 * Which agent steps carry no `data_policy`, and what feeds them?
 *
 * ADR-0021 is fail-soft — absent `data_policy` ⇒ `internal`, and the boundary
 * lets it through. Correct as a default, and it makes an undeclared step
 * invisible in a way a declared one is not. Measured 2026-08-26: **58 of 77**
 * agent steps in installed recipes declared none, against **0 of 22** in the
 * shipped templates.
 *
 * The tests that matter are not the counting. They are:
 *  - the report resolves each `{{ref}}` back to the TOOL that produced it,
 *    because a classification describes what a step HANDLES including whatever
 *    its tools return — a prompt mentioning nothing sensitive can still be
 *    handed a mailbox by the step above it;
 *  - it suggests no classification, ever. A declared-but-wrong label is worse
 *    than an assumed one, because it stops looking like a gap.
 */

import { describe, expect, it } from "vitest";
import {
  formatUndeclared,
  refsIn,
  undeclaredInRecipe,
} from "../undeclaredSteps.js";

const recipe = (steps: unknown[]) => ({ name: "r", steps });

describe("counting", () => {
  it("counts an agent step with no data_policy as undeclared", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([{ id: "a", agent: { prompt: "hi" } }]),
    );
    expect(r.agentSteps).toBe(1);
    expect(r.declared).toBe(0);
    expect(r.steps).toHaveLength(1);
  });

  it("accepts data_policy on the agent block (where templates put it)", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([
        {
          id: "a",
          agent: { prompt: "hi", data_policy: { classification: "personal" } },
        },
      ]),
    );
    expect(r.declared).toBe(1);
    expect(r.steps).toEqual([]);
  });

  /** Accepted at step level too — a false positive over a spelling is noise. */
  it("accepts data_policy at step level", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([
        {
          id: "a",
          agent: { prompt: "hi" },
          data_policy: { classification: "internal" },
        },
      ]),
    );
    expect(r.declared).toBe(1);
  });

  it("ignores tool steps entirely — they are not model dispatch", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([{ id: "t", tool: "file.read", into: "x" }]),
    );
    expect(r.agentSteps).toBe(0);
    expect(r.steps).toEqual([]);
  });

  it("a recipe with no steps is not a crash", () => {
    expect(undeclaredInRecipe("r", { name: "r" }).agentSteps).toBe(0);
    expect(undeclaredInRecipe("r", null).agentSteps).toBe(0);
  });
});

describe("what feeds the step is the point", () => {
  it("resolves a prompt ref back to the tool that produced it", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([
        { id: "fetch", tool: "gmail.fetch_unread", into: "messages" },
        { id: "sum", agent: { prompt: "summarise {{messages.json}}" } },
      ]),
    );
    expect(r.steps[0]?.feeds).toEqual([
      { ref: "messages", tool: "gmail.fetch_unread" },
    ]);
  });

  it("marks an upstream AGENT output as such rather than a tool", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([
        { id: "draft", agent: { prompt: "x", into: "notes", data_policy: {} } },
        { id: "use", agent: { prompt: "polish {{notes}}" } },
      ]),
    );
    expect(r.steps[0]?.feeds).toEqual([{ ref: "notes", fromAgent: true }]);
  });

  it("resolves a ref produced by a LATER step — order is the runner's problem", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([
        { id: "use", agent: { prompt: "{{later}}" } },
        { id: "l", tool: "http.get", into: "later" },
      ]),
    );
    expect(r.steps[0]?.feeds[0]?.tool).toBe("http.get");
  });

  it("separates refs nothing in the recipe produces", () => {
    const r = undeclaredInRecipe(
      "r",
      recipe([{ id: "a", agent: { prompt: "{{date}} {{nope}}" } }]),
    );
    expect(r.steps[0]?.feeds).toEqual([]);
    expect(r.steps[0]?.unresolvedRefs.sort()).toEqual(["date", "nope"]);
  });

  it("extracts the ROOT of a dotted ref", () => {
    expect(refsIn("{{messages.json}} {{ a.b.c }}").sort()).toEqual([
      "a",
      "messages",
    ]);
  });
});

describe("the report", () => {
  const rep = (undeclared: ReturnType<typeof undeclaredInRecipe>["steps"]) => ({
    recipesScanned: 3,
    agentSteps: 5,
    declared: 5 - undeclared.length,
    undeclared,
    unreadable: [] as string[],
  });

  it("leads with the denominator", () => {
    const out = formatUndeclared(
      rep(
        undeclaredInRecipe("r", recipe([{ id: "a", agent: { prompt: "x" } }]))
          .steps,
      ),
    );
    expect(out).toContain("1 of 5 agent step(s) across 3 recipe(s)");
  });

  /**
   * The load-bearing negative. Offering even a conservative starting label is
   * how an unexamined claim ends up declared.
   */
  it("suggests NO classification", () => {
    const out = formatUndeclared(
      rep(
        undeclaredInRecipe("r", recipe([{ id: "a", agent: { prompt: "x" } }]))
          .steps,
      ),
    );
    for (const label of ["personal", "confidential", "restricted", "suggest"]) {
      expect(out.toLowerCase()).not.toContain(`classification: ${label}`);
    }
    expect(out).toContain("No classification is suggested here on purpose");
  });

  it("distinguishes 'all declared' from 'no agent steps at all'", () => {
    expect(formatUndeclared({ ...rep([]), agentSteps: 5 })).toContain(
      "every agent step declares",
    );
    expect(formatUndeclared({ ...rep([]), agentSteps: 0 })).toContain(
      "no agent steps found",
    );
  });

  it("reports unreadable recipes rather than dropping them", () => {
    expect(
      formatUndeclared({ ...rep([]), unreadable: ["broken.yaml"] }),
    ).toContain("1 recipe(s) could not be parsed");
  });
});
