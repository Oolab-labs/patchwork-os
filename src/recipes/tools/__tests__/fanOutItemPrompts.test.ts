/**
 * Provenance gap 1 — fan_out agent-item prompts get the same treatment a
 * normal agent prompt gets.
 *
 * `fan_out` builds its own `iterCtx` and calls the BARE two-argument
 * `render` (`fanOut.ts`) before handing the prompt to `runNestedAgent`. So it
 * is a second LLM-facing render path that bypasses what `renderAgentPrompt`
 * does for every other agent step:
 *
 *   - `redactSecretsForPrompt` — so a declared env secret rendered into a
 *     fan_out item prompt in CLEAR TEXT where a normal step renders
 *     `[REDACTED]`. Not in the gap map; found by investigating. On the
 *     highest-volume path a recipe has.
 *   - the `wrap` hook — so connector-derived text reached the model with no
 *     `<untrusted>` envelope under governed.
 *
 * The system prompt is NOT part of this: #1583 wired the executor seam, and
 * `runNestedAgent` goes through `_executeAgent`, so fan_out iterations already
 * receive the governed instruction.
 *
 * ## Ownership
 *
 * The fix is a renderer INJECTED by `yamlRunner`, which owns `secretKeys`,
 * `untrustedProvenance` and `envelopeActive`. `fanOut.ts` knows none of those
 * concepts — teaching it profiles or secret keys would recreate exactly the
 * drift #1583 removed. A structural test below pins that.
 *
 * ## What is deliberately NOT solved
 *
 * Transitive taint. An item whose origin the existing map cannot prove — an
 * `agent_output`, a computed expression — gets NO envelope and NO invented
 * source. That evidence belongs to the later propagation PR; fabricating a
 * source here would make that PR unmeasurable.
 *
 * The one alias allowed is structural, not transitive: when `items` is exactly
 * `{{someKey}}` and `someKey` already has connector provenance, the loop
 * variable inherits THAT source for this render — "this item is one member of
 * that already-known connector result".
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../../../governance/profile.js";
import { UNTRUSTED_TAG } from "../../../governance/untrustedContent.js";
import { hasTool, registerTool } from "../../toolRegistry.js";
import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../../yamlRunner.js";

let tmpDir: string;
let prompts: string[];

/** A fake CONNECTOR tool, so its output earns provenance in the runner. */
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "fanout-items-"));
  prompts = [];
  _resetActiveProfileForTesting();
  if (!hasTool("testmail.list")) {
    registerTool({
      id: "testmail.list",
      namespace: "testmail",
      isConnector: true,
      description: "Test-only connector returning two message bodies.",
      paramsSchema: { type: "object", properties: {} },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: async () =>
        JSON.stringify([
          { id: "m1", body: "quarterly numbers, from outside" },
          { id: "m2", body: "second message body" },
        ]),
    } as never);
  }
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    testMode: true,
    now: () => new Date("2026-09-02T08:00:00Z"),
    logDir: tmpDir,
    claudeFn: async (prompt: string) => {
      prompts.push(prompt);
      return "ok";
    },
    ...overrides,
  } as RunnerDeps;
}

/** Fan an agent over the output of a connector step. */
function connectorFanRecipe(itemPrompt: string): YamlRecipe {
  return {
    name: "fan-connector",
    trigger: { type: "manual" },
    steps: [
      { tool: "testmail.list", into: "messages" },
      {
        tool: "fan_out",
        items: "{{messages}}",
        as: "row",
        into: "scrubbed",
        do: { agent: { prompt: itemPrompt, driver: "anthropic" } },
      },
    ],
  } as unknown as YamlRecipe;
}

/** Every prompt assertion first proves a dispatch actually happened. */
function itemPrompts(): string[] {
  expect(prompts.length).toBeGreaterThan(0);
  return prompts;
}

const governed = () =>
  setActiveProfile(resolveProfile({ profile: "governed" }));
const compat = () => setActiveProfile(resolveProfile({ profile: "compat" }));

describe("governed — connector-derived items are enveloped", () => {
  it("direct per-item interpolation `{{row.body}}` is wrapped", async () => {
    governed();
    await runYamlRecipe(connectorFanRecipe("Scrub this: {{row.body}}"), deps());
    const [first] = itemPrompts();
    expect(first).toContain(`<${UNTRUSTED_TAG} source="testmail.list"`);
    expect(first).toContain("quarterly numbers, from outside");
  });

  it("the whole flattened item `{{row}}` is wrapped too", async () => {
    governed();
    await runYamlRecipe(connectorFanRecipe("Scrub this: {{row}}"), deps());
    expect(itemPrompts()[0]).toContain(
      `<${UNTRUSTED_TAG} source="testmail.list"`,
    );
  });
});

describe("compat — ordinary bytes are unchanged", () => {
  it("a connector-derived item is NOT wrapped", async () => {
    compat();
    await runYamlRecipe(connectorFanRecipe("Scrub this: {{row.body}}"), deps());
    const [first] = itemPrompts();
    expect(first).not.toContain(`<${UNTRUSTED_TAG}`);
    expect(first).toBe("Scrub this: quarterly numbers, from outside");
  });
});

describe("secret redaction — in BOTH profiles, like a normal agent prompt", () => {
  const SECRET = "sk-live-FANOUT-LEAK-0003";

  function secretFanRecipe(): YamlRecipe {
    return {
      name: "fan-secret",
      trigger: { type: "manual" },
      context: [{ type: "env", keys: ["TEST_FANOUT_SECRET"] }],
      steps: [
        {
          tool: "fan_out",
          items: '["a","b"]',
          as: "doc",
          into: "out",
          do: {
            agent: {
              prompt: "Use {{TEST_FANOUT_SECRET}} on {{doc}}",
              driver: "anthropic",
            },
          },
        },
      ],
    } as unknown as YamlRecipe;
  }

  for (const profile of ["compat", "governed"] as const) {
    it(`${profile}: a declared env secret never reaches an item prompt`, async () => {
      setActiveProfile(resolveProfile({ profile }));
      vi.stubEnv("TEST_FANOUT_SECRET", SECRET);
      await runYamlRecipe(secretFanRecipe(), deps());
      for (const p of itemPrompts()) expect(p).not.toContain(SECRET);
    });
  }
});

describe("no source is invented where none is known", () => {
  it("an item with no provenance gets NO envelope, even under governed", async () => {
    governed();
    const r = {
      name: "fan-literal",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "fan_out",
          items: '["alpha","beta"]',
          as: "doc",
          into: "out",
          do: { agent: { prompt: "Scrub {{doc}}", driver: "anthropic" } },
        },
      ],
    } as unknown as YamlRecipe;
    await runYamlRecipe(r, deps());
    const [first] = itemPrompts();
    expect(first).not.toContain(`<${UNTRUSTED_TAG}`);
    expect(first).toBe("Scrub alpha");
  });
});

describe("fan_out holds no policy of its own", () => {
  it("fanOut.ts does not read profiles, secret keys or provenance", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(path.join(__dirname, "..", "fanOut.ts"), "utf-8");
    for (const forbidden of [
      "activeProfile",
      "redactSecretsForPrompt",
      "untrustedProvenance",
      "wrapUntrusted",
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
