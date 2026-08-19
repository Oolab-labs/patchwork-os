/**
 * A `data_policy` declared where nothing reads it (#1467).
 *
 * The bug, reproduced end to end before it was fixed: declaring the block as a
 * sibling of `agent:` instead of inside it produced `✓ Valid recipe (0
 * warnings)`, a successful run, and a boundary row reading
 * `labelSource: "assumed"` — identical to a step that declared nothing.
 *
 * These tests are about the ERROR being raised, and about it being raised in
 * exactly the wrong places and no others. A rule that fires on a correct
 * placement is worse than no rule: it teaches authors to ignore it.
 */

import { describe, expect, it } from "vitest";

import { misplacedDataPolicy } from "../dataPolicyPlacement.js";
import { validateRecipeDefinition } from "../validation.js";

describe("placements that are correct and must stay silent", () => {
  it("inside agent: — the one the runner reads", () => {
    expect(
      misplacedDataPolicy({
        id: "s",
        agent: { prompt: "x", data_policy: { classification: "confidential" } },
      }),
    ).toBeNull();
  });

  it("on a fan_out step — the batch's classification (#1466)", () => {
    expect(
      misplacedDataPolicy({
        id: "s",
        tool: "fan_out",
        items: "[]",
        do: { agent: { prompt: "x" } },
        data_policy: { classification: "confidential" },
      }),
    ).toBeNull();
  });

  it("a step with no data_policy at all", () => {
    expect(misplacedDataPolicy({ id: "s", agent: { prompt: "x" } })).toBeNull();
    expect(misplacedDataPolicy({ id: "s", tool: "file.read" })).toBeNull();
  });

  it("things that are not steps", () => {
    expect(misplacedDataPolicy(null)).toBeNull();
    expect(misplacedDataPolicy("nope")).toBeNull();
    expect(misplacedDataPolicy([])).toBeNull();
  });
});

describe("the misplacement that shipped", () => {
  it("flags a step-level data_policy alongside agent:, and says where it goes", () => {
    const r = misplacedDataPolicy({
      id: "digest",
      data_policy: { classification: "internal" },
      agent: { prompt: "x", driver: "local" },
    });

    expect(r).not.toBeNull();
    // The message has to name the remedy. An author who has just read ADR-0021,
    // written the block one level out and been told only "invalid" has nothing
    // to act on — and the correct nesting is one level in from where a reader
    // of the step naturally puts it.
    expect(r?.message).toMatch(/INSIDE `agent:`/);
    // And it must say what happens if they leave it, because "ignored" and
    // "defaults to internal" are different warnings and only the second
    // conveys the risk.
    expect(r?.message).toMatch(/internal/);
  });

  it("flags it on a step that makes no agent dispatch at all", () => {
    const r = misplacedDataPolicy({
      id: "w",
      tool: "file.write",
      data_policy: { classification: "confidential" },
    });

    expect(r).not.toBeNull();
    expect(r?.message).toMatch(/no agent dispatch/);
  });
});

describe("recipe lint refuses it", () => {
  function lintWithStep(step: Record<string, unknown>) {
    return validateRecipeDefinition({
      apiVersion: "patchwork.sh/v1",
      name: "t",
      description: "t",
      trigger: { type: "manual" },
      steps: [step],
    });
  }

  it("is an ERROR, not a warning", () => {
    // A warning would be the wrong severity for a dropped safety declaration:
    // `recipe lint` exits 0 on warnings, so CI and the dashboard install panel
    // would both go green on a recipe whose classification is inert.
    const res = lintWithStep({
      id: "digest",
      data_policy: { classification: "confidential" },
      agent: { prompt: "x", driver: "local" },
    });

    const hit = res.issues.find((i) => i.code === "data-policy-misplaced");
    expect(hit).toBeDefined();
    expect(hit?.level).toBe("error");
    expect(hit?.path).toBe("steps.0.data_policy");
    expect(res.valid).toBe(false);
  });

  it("stays silent on the correct nesting", () => {
    const res = lintWithStep({
      id: "digest",
      agent: {
        prompt: "x",
        driver: "local",
        data_policy: { classification: "confidential" },
      },
    });

    expect(
      res.issues.filter((i) => i.code === "data-policy-misplaced"),
    ).toEqual([]);
  });

  it("stays silent on a fan_out step", () => {
    const res = lintWithStep({
      id: "scrub",
      tool: "fan_out",
      items: '["a"]',
      do: { agent: { prompt: "x", driver: "local" } },
      data_policy: { classification: "confidential" },
    });

    expect(
      res.issues.filter((i) => i.code === "data-policy-misplaced"),
    ).toEqual([]);
  });
});
