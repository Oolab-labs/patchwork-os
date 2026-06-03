/**
 * Guard for the flagship `incident-to-pr` recipe.
 *
 * `incident-to-pr.yaml` is the end-to-end showcase: incident → autonomous
 * root-cause → fix draft → judge→refine loop (#859) → human approval gate →
 * pull request. Because it is the recipe we point new users at, it must stay
 * (a) schema-valid and (b) wired so the judge→refine loop actually ENGAGES —
 * the subtle failure mode is a judge whose `reviews` key nothing writes to, in
 * which case `runJudgeRefineLoop` finds no step to re-run and the loop silently
 * no-ops. This test pins both.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseRecipe } from "../parser.js";
import { validateRecipeDefinition } from "../validation.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/recipes/__tests__ → repo root is three levels up.
const recipePath = join(
  here,
  "..",
  "..",
  "..",
  "templates",
  "recipes",
  "incident-to-pr.yaml",
);

interface AgentLike {
  kind?: string;
  reviews?: string;
  max_revisions?: number;
  into?: string;
}
interface StepLike {
  agent?: AgentLike;
}

const raw = readFileSync(recipePath, "utf8");
const recipe = parseYaml(raw) as { steps?: StepLike[] };

describe("flagship incident-to-pr recipe", () => {
  it("validates against the recipe schema with zero errors", () => {
    const result = validateRecipeDefinition(recipe);
    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
    expect(result.errors).toBe(0);
  });

  it("parses without throwing (the install path)", () => {
    expect(() => parseRecipe(recipe)).not.toThrow();
  });

  it("wires the judge→refine loop so it actually engages", () => {
    const steps = recipe.steps ?? [];

    const judge = steps.find((s) => s.agent?.kind === "judge");
    expect(judge, "expected a kind:judge step").toBeTruthy();
    const j = judge?.agent as AgentLike;

    // A bounded revision loop the judge can drive.
    expect(typeof j.max_revisions).toBe("number");
    expect(j.max_revisions ?? 0).toBeGreaterThan(0);
    expect(j.reviews, "judge must review a ctx key").toBeTruthy();

    // The reviewed step must write into the SAME ctx key the judge reviews —
    // yamlRunner finds the step to re-run via
    // (s.agent.into ?? "agent_output") === reviewsKey. If nothing writes that
    // key, the loop no-ops and the "moat" is decorative.
    const reviewed = steps.find(
      (s) => s.agent && (s.agent.into ?? "agent_output") === j.reviews,
    );
    expect(
      reviewed,
      `no step writes into "${j.reviews}" — the refine loop would silently no-op`,
    ).toBeTruthy();
  });
});
