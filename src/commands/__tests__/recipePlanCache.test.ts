/**
 * The dry-run plan is cached, and the cache can never serve a stale plan.
 *
 * Building a plan is synchronous CPU: parse the YAML, normalise it, run every
 * lint rule, enrich each step from the tool registry. A dashboard that shows
 * readiness for every installed recipe asks for one plan per recipe, so that
 * cost blocks the event loop once per recipe per page load.
 *
 * The cache is only worth having if it is invisible. These tests pin both
 * halves: a repeat request does no parse and no lint, and every input the plan
 * depends on — the file's bytes, the tool registry, the request options, the
 * clock (for recipes that render `{{date}}` / `{{time}}`), the lint
 * environment — produces a fresh plan when it changes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ parse: 0, lint: 0 }));

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      counts.parse++;
      return actual.parse(...args);
    },
  };
});

vi.mock("../../recipes/validation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../recipes/validation.js")>();
  return {
    ...actual,
    validateRecipeDefinition: (
      ...args: Parameters<typeof actual.validateRecipeDefinition>
    ) => {
      counts.lint++;
      return actual.validateRecipeDefinition(...args);
    },
  };
});

import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../../governance/profile.js";
import { registerTool } from "../../recipes/toolRegistry.js";
import {
  _clearRecipePlanCacheForTesting,
  runRecipeDryPlan,
} from "../recipe.js";

let dir: string;
const savedApiKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "recipe-plan-cache-"));
  _clearRecipePlanCacheForTesting();
  counts.parse = 0;
  counts.lint = 0;
  // A recipe outside the recipe jail logs a notice; not what is under test.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  _resetActiveProfileForTesting();
  vi.restoreAllMocks();
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
}

const FLAT = `name: plan-cache-flat
trigger:
  type: manual
steps:
  - tool: file.read
    path: example.txt
    into: content
`;

/** Strip the one field that is a timestamp of THIS call, not of the plan. */
function comparable(plan: Record<string, unknown>): Record<string, unknown> {
  const { generatedAt: _ignored, ...rest } = plan;
  return rest;
}

describe("recipe dry-run plan cache", () => {
  it("a repeat request does no parse and no lint, and returns an equal plan", async () => {
    const file = write("flat.yaml", FLAT);
    const first = await runRecipeDryPlan(file);
    expect(counts.parse).toBeGreaterThan(0);
    expect(counts.lint).toBeGreaterThan(0);

    const parseAfterFirst = counts.parse;
    const lintAfterFirst = counts.lint;
    const second = await runRecipeDryPlan(file);

    expect(counts.parse).toBe(parseAfterFirst);
    expect(counts.lint).toBe(lintAfterFirst);
    expect(comparable(second as never)).toEqual(comparable(first as never));
  });

  it("parses the file once, not twice, on a miss", async () => {
    const file = write("flat.yaml", FLAT);
    await runRecipeDryPlan(file);
    expect(counts.parse).toBe(1);
    expect(counts.lint).toBe(1);
  });

  it("changed file content produces a fresh plan", async () => {
    const file = write("flat.yaml", FLAT);
    const first = await runRecipeDryPlan(file);
    write("flat.yaml", FLAT.replace("into: content", "into: renamed"));
    const second = await runRecipeDryPlan(file);

    expect(second.recipeSha256).not.toBe(first.recipeSha256);
    expect(second.steps[0]?.into).toBe("renamed");
  });

  it("a tool registry change produces a fresh plan", async () => {
    const toolId = `plancache.probe${Date.now()}`;
    const file = write(
      "flat.yaml",
      `name: plan-cache-registry
trigger:
  type: manual
steps:
  - tool: ${toolId}
    into: out
`,
    );
    const before = await runRecipeDryPlan(file);
    expect(before.steps[0]?.resolved).toBe(false);

    registerTool({
      id: toolId,
      namespace: "plancache",
      description: "probe",
      paramsSchema: {},
      outputSchema: {},
      riskDefault: "high",
      isWrite: true,
      execute: async () => null,
    });

    const after = await runRecipeDryPlan(file);
    expect(after.steps[0]?.resolved).toBe(true);
    expect(after.hasWriteSteps).toBe(true);
  });

  it("different options are separate entries", async () => {
    const file = write(
      "vars.yaml",
      `name: plan-cache-vars
trigger:
  type: manual
steps:
  - tool: file.read
    id: first
    path: "{{who}}.txt"
  - tool: file.read
    id: second
    path: other.txt
`,
    );
    const whole = await runRecipeDryPlan(file);
    expect(whole.steps).toHaveLength(2);
    const a = await runRecipeDryPlan(file, { vars: { who: "alpha" } });
    const b = await runRecipeDryPlan(file, { vars: { who: "beta" } });
    const step = await runRecipeDryPlan(file, { step: "second" });

    expect(a.steps[0]?.params?.path).toBe("alpha.txt");
    expect(b.steps[0]?.params?.path).toBe("beta.txt");
    expect(step.steps).toHaveLength(1);
    expect(step.steps[0]?.id).toBe("second");

    // And each of those is itself served from the cache on repeat.
    const lintBefore = counts.lint;
    const a2 = await runRecipeDryPlan(file, { vars: { who: "alpha" } });
    expect(counts.lint).toBe(lintBefore);
    expect(a2.steps[0]?.params?.path).toBe("alpha.txt");
  });

  it("mutating a returned plan does not affect the next one", async () => {
    const file = write("flat.yaml", FLAT);
    const first = await runRecipeDryPlan(file);
    const pristine = structuredClone(first);
    first.steps[0]!.into = "tampered";
    first.lint.errors.push("tampered");

    const second = await runRecipeDryPlan(file);
    second.steps.length = 0;
    const third = await runRecipeDryPlan(file);

    expect(comparable(third as never)).toEqual(comparable(pristine as never));
  });

  it("chained recipes are not cached: a child change is always seen", async () => {
    write(
      "child.yaml",
      `name: plan-cache-child
trigger:
  type: manual
steps:
  - tool: file.read
    path: a.txt
`,
    );
    const parent = write(
      "parent.yaml",
      `name: plan-cache-parent
trigger:
  type: chained
steps:
  - id: run_child
    recipe: ./child.yaml
`,
    );
    const first = await runRecipeDryPlan(parent);
    expect(first.lint.errors).toEqual([]);

    // Break the child without touching the parent's bytes.
    write("child.yaml", "name: plan-cache-child\nsteps: not-a-list\n");
    const second = await runRecipeDryPlan(parent);
    expect(second.lint.errors.length).toBeGreaterThan(0);
  });

  it("a recipe that renders {{date}} is rebuilt when the minute changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const file = write(
      "dated.yaml",
      `name: plan-cache-dated
trigger:
  type: manual
steps:
  - tool: file.write
    path: "notes/{{ date }}.md"
    content: x
`,
    );
    const first = await runRecipeDryPlan(file);
    expect(first.steps[0]?.params?.path).toBe("notes/2026-03-01.md");

    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const second = await runRecipeDryPlan(file);
    expect(second.steps[0]?.params?.path).toBe("notes/2026-03-02.md");
  });

  it("a recipe that renders no clock token stays cached across time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const file = write("flat.yaml", FLAT);
    await runRecipeDryPlan(file);
    const lintBefore = counts.lint;

    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const second = await runRecipeDryPlan(file);
    expect(counts.lint).toBe(lintBefore);
    // The call timestamp is this call's, not the cached one.
    expect(second.generatedAt).toBe("2026-03-02T10:00:00.000Z");
  });

  it("the lint environment is part of the key (API-key presence)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const file = write(
      "agent.yaml",
      `name: plan-cache-agent
trigger:
  type: manual
steps:
  - agent:
      driver: claude
      prompt: say hi
    into: out
`,
    );
    const without = await runRecipeDryPlan(file);
    expect(
      without.lint.warnings.some((w) => w.includes("ANTHROPIC_API_KEY")),
    ).toBe(true);

    process.env.ANTHROPIC_API_KEY = "test-placeholder";
    const withKey = await runRecipeDryPlan(file);
    expect(
      withKey.lint.warnings.some((w) => w.includes("ANTHROPIC_API_KEY")),
    ).toBe(false);
  });

  it("a recipe declaring servers: is rebuilt when the plugin policy changes", async () => {
    const file = write(
      "servers.yaml",
      `name: plan-cache-servers
servers:
  - ./plan-cache-unlisted-plugin
trigger:
  type: manual
steps:
  - tool: file.read
    path: a.txt
`,
    );
    const compat = await runRecipeDryPlan(file);
    expect(compat.lint.errors.some((e) => e.includes("plugin"))).toBe(false);
    expect(compat.lint.warnings.some((w) => w.includes("plugin"))).toBe(true);

    setActiveProfile(GOVERNED_PROFILE);
    const governed = await runRecipeDryPlan(file);
    expect(governed.lint.errors.some((e) => e.includes("plugin"))).toBe(true);
  });

  it("does not cache a recipe that fails to load", async () => {
    const file = write("bad.yaml", "name: x\nsteps: []\n");
    await expect(runRecipeDryPlan(file)).rejects.toThrow();
    write("bad.yaml", FLAT);
    const ok = await runRecipeDryPlan(file);
    expect(ok.recipe).toBe("plan-cache-flat");
  });
});
