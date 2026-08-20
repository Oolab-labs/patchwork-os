/**
 * Regression test for #1464 — `templates/recipes/butler-errand.yaml` passed
 * `project_id` to `todoist.create_task`, which declares `projectId`.
 *
 * Why this failed silently, and why a test rather than a drive-by commit:
 * `executeStep` (yamlRunner.ts) builds a tool's params from EVERY step key
 * except `tool` / `agent` / `into`, and no tool's `paramsSchema` sets
 * `additionalProperties: false`. So an undeclared key is accepted, rendered,
 * handed to the executor, and ignored — `resolvedParams` in the run log even
 * records it faithfully, because that is what the recipe said. The task is
 * created, the run succeeds, and the only symptom is that every Butler errand
 * lands in the default inbox regardless of the `project_id` var the operator
 * set.
 *
 * Scope is deliberately this ONE template, not a general lint rule. The step
 * control keys and the tool params share one flat namespace, and the set of
 * control keys exists only implicitly across validation.ts, yamlRunner.ts and
 * compiler.ts — there is no authoritative list to check an arbitrary recipe
 * against. Inventing one here would be a correct-looking rule pointed at a
 * partial surface. `butler-errand.yaml` is the reference worker bundle, its
 * step set is small and enumerable, so the narrow check is sound where the
 * general one is not. See the measurement in #1464.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import "../tools/index.js";
import { getTool } from "../toolRegistry.js";

const TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates/recipes/butler-errand.yaml",
);

/**
 * Step keys `executeStep` consumes itself rather than forwarding to the tool,
 * plus the keys the validator/compiler own. Hand-maintained ON PURPOSE and
 * safe only because the surface is one small template — see the module doc.
 */
const STEP_CONTROL_KEYS = new Set([
  "tool",
  "agent",
  "into",
  "id",
  "when",
  "do",
  "optional",
  "retry",
  "retryDelay",
  "transform",
  "expect",
  "timeout_ms",
  "silentFailDetection",
  "risk",
  "awaits",
  "data_policy",
]);

interface Step {
  tool?: string;
  [key: string]: unknown;
}

let steps: Step[];

beforeAll(() => {
  const doc = parseYaml(readFileSync(TEMPLATE, "utf8")) as { steps: Step[] };
  steps = doc.steps;
});

describe("#1464: butler-errand template names declared tool parameters", () => {
  it("registers the tools the template calls (guards a silently empty registry)", () => {
    const toolSteps = steps.filter((s) => typeof s.tool === "string");
    expect(toolSteps.length).toBeGreaterThan(0);
    for (const step of toolSteps) {
      expect(getTool(step.tool as string), `tool ${step.tool}`).toBeDefined();
    }
  });

  it("passes no undeclared parameter to any tool step", () => {
    const offenders: string[] = [];
    for (const step of steps) {
      if (typeof step.tool !== "string") continue;
      const tool = getTool(step.tool);
      if (!tool) continue;
      const declared = Object.keys(
        (tool.paramsSchema?.properties ?? {}) as Record<string, unknown>,
      );
      for (const key of Object.keys(step)) {
        if (STEP_CONTROL_KEYS.has(key)) continue;
        if (!declared.includes(key)) offenders.push(`${step.tool}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("files into the Todoist project the operator named", () => {
    const create = steps.find((s) => s.tool === "todoist.create_task");
    expect(create).toBeDefined();
    // The declared name, and the var the trigger exposes, must both be right —
    // renaming the key while dropping the var would pass the check above and
    // still file everything into the inbox.
    expect(create).toHaveProperty("projectId", "{{project_id}}");
    expect(create).not.toHaveProperty("project_id");
  });
});
