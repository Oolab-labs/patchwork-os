/**
 * Tests for `runNewInteractive` — the connector-aware prompt tree
 * behind `patchwork recipe new --interactive`.
 *
 * The prompt deps are injected so the test drives a fixed sequence
 * of answers and asserts the generated YAML shape. Each kind=N constant
 * matches the step-kind-choice index from runNewInteractive:
 *   KIND_TOOL  = 1  ("Add a tool step")
 *   KIND_AGENT = 2  ("Add an agent step")
 *   KIND_DONE  = 3  ("Done — preview and write")
 *
 * Schema-drift firewall: `validateRecipeDefinition` is invoked inside
 * the function, so a real schema change that the generator violates
 * will surface here as a `result.warnings` entry of level "error" —
 * the tests assert that array is empty so a regression breaks the build.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../recipes/tools/index.js";
import { type InteractivePromptDeps, runNewInteractive } from "../recipe.js";

const KIND_TOOL = 1;
const KIND_AGENT = 2;
const KIND_DONE = 3;

/**
 * Build a prompt-deps stub that returns a fixed sequence of answers.
 * Each call to ask/pickFromList/confirm consumes one entry of the
 * corresponding queue. Throws if the test under-feeds (so missing
 * answers fail loud).
 */
function makeStubDeps(answers: {
  ask: string[];
  pickFromList: number[];
  confirm: boolean[];
}): InteractivePromptDeps {
  const ask = [...answers.ask];
  const pick = [...answers.pickFromList];
  const conf = [...answers.confirm];
  return {
    ask: async (_q) => {
      const a = ask.shift();
      if (a === undefined) throw new Error("ran out of ask answers");
      return a;
    },
    pickFromList: async (_q, _opts) => {
      const a = pick.shift();
      if (a === undefined) throw new Error("ran out of pickFromList answers");
      return a;
    },
    confirm: async (_q) => {
      const a = conf.shift();
      if (a === undefined) throw new Error("ran out of confirm answers");
      return a;
    },
  };
}

describe("runNewInteractive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "patchwork-recipe-new-int-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manual trigger + single agent step writes valid YAML", async () => {
    const deps = makeStubDeps({
      ask: ["my-test-recipe", "Test description", "Summarize the input"],
      pickFromList: [
        1, // trigger type: manual
        KIND_AGENT, // step 1: agent
        KIND_DONE, // step 2: done
      ],
      confirm: [
        true, // write to disk
      ],
    });

    const result = await runNewInteractive({ outputDir: tmpDir, deps });

    expect(existsSync(result.path)).toBe(true);
    expect(result.path.endsWith("my-test-recipe.yaml")).toBe(true);

    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain("name: my-test-recipe");
    expect(content).toContain("type: manual");
    expect(content).toContain("agent: true");
    expect(content).toContain("Summarize the input");
    expect(content).toContain("tool: file.write");
    // No connector tool steps — only the file.write tail.
    const toolLines = content
      .split("\n")
      .filter((line) => line.trim().startsWith("- tool:"));
    expect(toolLines.length).toBe(1);
    // Tail file.write references the agent output.
    expect(content).toContain("{{agent_output}}");

    const errors = result.warnings.filter((w) => w.level === "error");
    expect(errors).toEqual([]);
  });

  it("cron trigger + tool step (no agent) writes valid YAML with cron line", async () => {
    const { listConnectorNamespaces, listTools } = await import(
      "../../recipes/toolRegistry.js"
    );
    const namespaces = listConnectorNamespaces();
    expect(namespaces.length).toBeGreaterThan(0); // sanity

    // Walk the registry deterministically to find the first connector
    // whose first tool has zero required params — keeps the test from
    // breaking when a new connector lands with required fields.
    let chosenNsIdx = -1;
    let chosenToolIdx = -1;
    outer: for (let i = 0; i < namespaces.length; i++) {
      const ns = namespaces[i];
      if (!ns) continue;
      const tools = listTools(ns);
      for (let j = 0; j < tools.length; j++) {
        const schema = tools[j]?.paramsSchema as { required?: unknown } | null;
        const required = Array.isArray(schema?.required)
          ? (schema?.required as unknown[])
          : [];
        if (required.length === 0) {
          chosenNsIdx = i + 1;
          chosenToolIdx = j + 1;
          break outer;
        }
      }
    }
    expect(chosenNsIdx).toBeGreaterThan(0);
    expect(chosenToolIdx).toBeGreaterThan(0);

    const deps = makeStubDeps({
      ask: ["my-cron-recipe", "Daily cron test", "0 8 * * *"],
      pickFromList: [
        2, // trigger type: cron
        KIND_TOOL, // step 1: tool
        chosenNsIdx, // pick connector
        chosenToolIdx, // pick tool (zero-required-params)
        KIND_DONE, // step 2: done
      ],
      confirm: [
        true, // write
      ],
    });

    const result = await runNewInteractive({ outputDir: tmpDir, deps });

    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain("name: my-cron-recipe");
    expect(content).toContain("type: cron");
    expect(content).toContain("0 8 * * *");
    // Two tool steps: the connector + the file.write tail.
    const toolLines = content
      .split("\n")
      .filter((line) => line.trim().startsWith("- tool:"));
    expect(toolLines.length).toBe(2);
    expect(content).not.toContain("agent: true");

    const errors = result.warnings.filter((w) => w.level === "error");
    expect(errors).toEqual([]);
  });

  it("multi-step recipe: 2 tool steps + 1 agent step", async () => {
    const { listConnectorNamespaces, listTools } = await import(
      "../../recipes/toolRegistry.js"
    );
    const namespaces = listConnectorNamespaces();

    // Find two zero-required-param tools (may be in the same ns or different).
    const picks: Array<{ ns: number; tool: number }> = [];
    outer: for (let i = 0; i < namespaces.length && picks.length < 2; i++) {
      const ns = namespaces[i];
      if (!ns) continue;
      const tools = listTools(ns);
      for (let j = 0; j < tools.length && picks.length < 2; j++) {
        const schema = tools[j]?.paramsSchema as { required?: unknown } | null;
        const required = Array.isArray(schema?.required)
          ? (schema?.required as unknown[])
          : [];
        if (required.length === 0) {
          picks.push({ ns: i + 1, tool: j + 1 });
          if (picks.length >= 2) break outer;
        }
      }
    }
    expect(picks.length).toBe(2);

    const deps = makeStubDeps({
      ask: ["multi-step", "Two tool steps + agent", "Summarize results"],
      pickFromList: [
        1, // trigger: manual
        KIND_TOOL,
        picks[0]!.ns,
        picks[0]!.tool,
        KIND_TOOL,
        picks[1]!.ns,
        picks[1]!.tool,
        KIND_AGENT,
        KIND_DONE,
      ],
      confirm: [true],
    });

    const result = await runNewInteractive({ outputDir: tmpDir, deps });
    const content = readFileSync(result.path, "utf-8");

    // Three tool steps in steps[] (2 connectors) + file.write tail = 3 lines
    const toolLines = content
      .split("\n")
      .filter((line) => line.trim().startsWith("- tool:"));
    expect(toolLines.length).toBe(3);
    expect(content).toContain("agent: true");
    // Tail references the agent_output (most recent).
    expect(content).toContain("{{agent_output}}");

    const errors = result.warnings.filter((w) => w.level === "error");
    expect(errors).toEqual([]);
  });

  it("prompts for the tool's required params from paramsSchema", async () => {
    const { listConnectorNamespaces, listTools } = await import(
      "../../recipes/toolRegistry.js"
    );
    const namespaces = listConnectorNamespaces();

    // Find the first tool with >=1 required param.
    let chosenNsIdx = -1;
    let chosenToolIdx = -1;
    let requiredKeys: string[] = [];
    outer: for (let i = 0; i < namespaces.length; i++) {
      const ns = namespaces[i];
      if (!ns) continue;
      const tools = listTools(ns);
      for (let j = 0; j < tools.length; j++) {
        const schema = tools[j]?.paramsSchema as { required?: unknown } | null;
        const reqArr = Array.isArray(schema?.required)
          ? (schema?.required as unknown[])
          : [];
        const filtered = reqArr.filter(
          (k): k is string => typeof k === "string" && k !== "into",
        );
        if (filtered.length > 0) {
          chosenNsIdx = i + 1;
          chosenToolIdx = j + 1;
          requiredKeys = filtered;
          break outer;
        }
      }
    }
    // If no connector tool exposes a required param, skip with a clear note.
    if (chosenNsIdx === -1) {
      // eslint-disable-next-line no-console
      console.warn(
        "No connector tool with required params found — skipping required-params test",
      );
      return;
    }

    const stubAnswers = requiredKeys.map((k) => `value_for_${k}`);

    const deps = makeStubDeps({
      ask: ["needs-params", "Test required params", ...stubAnswers],
      pickFromList: [
        1, // manual
        KIND_TOOL,
        chosenNsIdx,
        chosenToolIdx,
        KIND_DONE,
      ],
      confirm: [true],
    });

    const result = await runNewInteractive({ outputDir: tmpDir, deps });
    const content = readFileSync(result.path, "utf-8");

    // Each required key + its stub value should appear in the YAML.
    for (let i = 0; i < requiredKeys.length; i++) {
      const key = requiredKeys[i]!;
      const value = stubAnswers[i]!;
      expect(content).toContain(`    ${key}: ${value}`);
    }

    const errors = result.warnings.filter((w) => w.level === "error");
    expect(errors).toEqual([]);
  });

  it("rejects invalid recipe names with the validation hint", async () => {
    const deps = makeStubDeps({
      ask: ["INVALID-Name", "valid-name", "desc", "prompt"],
      pickFromList: [
        1, // manual
        KIND_AGENT, // agent step
        KIND_DONE,
      ],
      confirm: [true],
    });

    const result = await runNewInteractive({ outputDir: tmpDir, deps });
    expect(result.path.endsWith("valid-name.yaml")).toBe(true);
  });

  it("cancels cleanly when user declines the final write", async () => {
    const deps = makeStubDeps({
      ask: ["cancel-test", "desc"],
      pickFromList: [
        1, // manual
        KIND_DONE, // no steps
      ],
      confirm: [
        false, // decline write
      ],
    });

    await expect(
      runNewInteractive({ outputDir: tmpDir, deps }),
    ).rejects.toThrow(/Cancelled/);
  });
});
