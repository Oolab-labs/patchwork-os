/**
 * Tests for `runNewInteractive` — the connector-aware prompt tree
 * behind `patchwork recipe new --interactive`.
 *
 * The prompt deps are injected so the test drives a fixed sequence
 * of answers and asserts the generated YAML shape. Two paths covered:
 *   1. Manual trigger + agent step + tail write
 *   2. Cron trigger + connector tool + agent step + tail write
 *
 * Schema-drift firewall: `validateRecipeDefinition` is invoked inside
 * the function, so a real schema change that the generator violates
 * will surface here as a `result.warnings` entry — the test asserts
 * no errors among warnings so a regression breaks the build.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../recipes/tools/index.js";
import { type InteractivePromptDeps, runNewInteractive } from "../recipe.js";

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

  it("manual trigger + skip connector + agent step writes valid YAML", async () => {
    const deps = makeStubDeps({
      ask: ["my-test-recipe", "Test description", "Summarize the input"],
      pickFromList: [
        1, // trigger type: manual
        99, // connector pick: out-of-range to force "skip" (last option)
      ],
      confirm: [
        true, // add agent step
        true, // write to disk
      ],
    });

    // pickFromList=99 is invalid; the test deps don't validate, but the
    // runNewInteractive flow does (it treats "out of namespaces range"
    // as the "skip" branch). Recompute with a valid skip index.
    // The "skip" option is appended after the namespaces, so a stable
    // sentinel is: pick the largest valid index by counting registered
    // namespaces first.
    // For simplicity, rebuild deps with the right skip index.
    const { listConnectorNamespaces } = await import(
      "../../recipes/toolRegistry.js"
    );
    const skipIdx = listConnectorNamespaces().length + 1;
    const deps2 = makeStubDeps({
      ask: ["my-test-recipe", "Test description", "Summarize the input"],
      pickFromList: [1, skipIdx],
      confirm: [true, true],
    });
    void deps; // first build was a no-op for skipIdx discovery

    const result = await runNewInteractive({
      outputDir: tmpDir,
      deps: deps2,
    });

    expect(existsSync(result.path)).toBe(true);
    expect(result.path.endsWith("my-test-recipe.yaml")).toBe(true);

    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain("name: my-test-recipe");
    expect(content).toContain("description: ");
    expect(content).toContain("type: manual");
    expect(content).toContain("agent: true");
    expect(content).toContain("Summarize the input");
    expect(content).toContain("tool: file.write");
    // Skipped connector — no tool step before the file.write tail.
    // The only `- tool:` line should be the tail.
    const toolLines = content
      .split("\n")
      .filter((line) => line.trim().startsWith("- tool:"));
    expect(toolLines.length).toBe(1);

    // No schema-drift errors should be present in warnings (warnings of
    // level "warning" are tolerated — this gate is for real errors).
    const errors = result.warnings.filter((w) => w.level === "error");
    expect(errors).toEqual([]);
  });

  it("cron trigger + connector + no agent writes valid YAML with cron line", async () => {
    const { listConnectorNamespaces } = await import(
      "../../recipes/toolRegistry.js"
    );
    const namespaces = listConnectorNamespaces();
    expect(namespaces.length).toBeGreaterThan(0); // sanity — registry is hydrated

    const firstNsIdx = 1;
    const deps = makeStubDeps({
      ask: [
        "my-cron-recipe",
        "Daily cron test",
        "0 8 * * *", // cron expression
      ],
      pickFromList: [
        2, // trigger type: cron
        firstNsIdx, // pick first connector namespace
        1, // pick first tool from that namespace
      ],
      confirm: [
        false, // skip agent step
        true, // write to disk
      ],
    });

    const result = await runNewInteractive({
      outputDir: tmpDir,
      deps,
    });

    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain("name: my-cron-recipe");
    expect(content).toContain("type: cron");
    expect(content).toContain("at: ");
    expect(content).toContain("0 8 * * *");
    // Connector tool step landed before the file.write tail.
    const toolLines = content
      .split("\n")
      .filter((line) => line.trim().startsWith("- tool:"));
    expect(toolLines.length).toBe(2); // connector + file.write tail
    // No agent step.
    expect(content).not.toContain("agent: true");

    const errors = result.warnings.filter((w) => w.level === "error");
    expect(errors).toEqual([]);
  });

  it("rejects invalid recipe names with the validation hint", async () => {
    // First answer is invalid (uppercase), second is valid. The
    // generator re-asks; askWithValidation surfaces the rule in the
    // re-asked question. We just confirm the eventual valid answer
    // produces the recipe rather than crashing.
    const { listConnectorNamespaces } = await import(
      "../../recipes/toolRegistry.js"
    );
    const skipIdx = listConnectorNamespaces().length + 1;
    const deps = makeStubDeps({
      ask: [
        "INVALID-Name", // rejected — uppercase
        "valid-name", // accepted
        "desc",
        "prompt",
      ],
      pickFromList: [1, skipIdx],
      confirm: [true, true],
    });

    const result = await runNewInteractive({ outputDir: tmpDir, deps });
    expect(result.path.endsWith("valid-name.yaml")).toBe(true);
  });

  it("cancels cleanly when user declines the final write", async () => {
    const { listConnectorNamespaces } = await import(
      "../../recipes/toolRegistry.js"
    );
    const skipIdx = listConnectorNamespaces().length + 1;
    const deps = makeStubDeps({
      ask: ["cancel-test", "desc"],
      pickFromList: [1, skipIdx],
      confirm: [
        false, // no agent step
        false, // decline write
      ],
    });

    await expect(
      runNewInteractive({ outputDir: tmpDir, deps }),
    ).rejects.toThrow(/Cancelled/);
  });
});
