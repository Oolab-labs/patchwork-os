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

import {
  misplacedDataPolicy,
  unclassifiedToolEnabledAgent,
} from "../dataPolicyPlacement.js";
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

/**
 * #1473 — classify by what a step HANDLES, not by what is in its prompt.
 *
 * A tool-enabled step's prompt is frequently instructions to go and fetch the
 * data rather than the data itself, so an author classifying what they can see
 * under-classifies what the step handles. This hint marks that population.
 *
 * It is a WARNING on purpose. Absence of a `data_policy` is a legitimate,
 * documented default, so an error here would break existing recipes to solve a
 * problem those recipes may not have — the exact failure ADR-0021's fail-soft
 * choice exists to avoid.
 */
describe("#1473: unclassifiedToolEnabledAgent", () => {
  const prompt = "Run `ls ~/records` and summarise what you find";

  it("hints at a tool-enabled agent step with no data_policy", () => {
    const hit = unclassifiedToolEnabledAgent({
      agent: { driver: "claude-code", prompt },
    });
    expect(hit?.message).toMatch(/what the step HANDLES/);
  });

  it("covers subprocess and codex too", () => {
    for (const driver of ["subprocess", "codex"]) {
      expect(
        unclassifiedToolEnabledAgent({ agent: { driver, prompt } }),
      ).not.toBeNull();
    }
  });

  it("stays silent once a policy is declared in the right place", () => {
    expect(
      unclassifiedToolEnabledAgent({
        agent: {
          driver: "claude-code",
          prompt,
          data_policy: { classification: "personal" },
        },
      }),
    ).toBeNull();
  });

  it("stays silent on a driver that cannot fetch", () => {
    expect(
      unclassifiedToolEnabledAgent({ agent: { driver: "local", prompt } }),
    ).toBeNull();
  });

  it("does not fire on a step whose driver is absent (auto)", () => {
    // Named limit, not an oversight: `auto` resolves at run time and may well
    // become tool-enabled, but flagging every driver-less agent step would flag
    // most steps in most recipes. The hint text says so rather than implying
    // total coverage.
    expect(unclassifiedToolEnabledAgent({ agent: { prompt } })).toBeNull();
  });

  it("says out loud that it cannot see an `auto` step", () => {
    const hit = unclassifiedToolEnabledAgent({
      agent: { driver: "subprocess", prompt },
    });
    expect(hit?.message).toMatch(/cannot see[\s\S]*`auto`/);
  });

  it("defers to the misplacement error rather than doubling up", () => {
    // One author mistake must produce one message. Both firing would suggest
    // opposite fixes: "move it inside agent" and "add one".
    const step = {
      agent: { driver: "claude-code", prompt },
      data_policy: { classification: "personal" },
    };
    expect(misplacedDataPolicy(step)).not.toBeNull();
    expect(unclassifiedToolEnabledAgent(step)).toBeNull();
  });

  it("ignores a tool step, which makes no dispatch at all", () => {
    expect(
      unclassifiedToolEnabledAgent({ tool: "file.read", path: "x" }),
    ).toBeNull();
  });
});

describe("#1473: surfaced by the validator as a warning, never an error", () => {
  const recipe = {
    name: "tool-enabled-unlabelled",
    trigger: { type: "manual" },
    steps: [
      {
        id: "s1",
        agent: {
          driver: "claude-code",
          prompt: "Read ~/records and summarise",
        },
      },
    ],
  };

  it("reports it, and the recipe still validates", () => {
    const result = validateRecipeDefinition(recipe);
    const hint = result.issues.find(
      (i) => i.code === "data-policy-tool-enabled-unclassified",
    );
    expect(hint).toBeDefined();
    expect(hint?.level).toBe("warning");
    // The whole point of a hint: it must not break an existing recipe.
    expect(result.issues.some((i) => i.level === "error")).toBe(false);
  });
});
