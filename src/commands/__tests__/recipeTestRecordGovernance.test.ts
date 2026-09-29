/**
 * `recipe test` is evidence-only and `recipe record` is governed like
 * `recipe run --local` (ADR-0026 known bypass: "recipe test/record are
 * ungated").
 *
 *   - test: a step whose tool has no mock/fixture is REFUSED at the dispatch
 *     seam (`test_refused_unmocked_step`), never run live; an agent step with
 *     no injected driver never dispatches; the chained path stays fully mocked.
 *   - record: resolves the same governance `recipe run --local` does — tier
 *     approval on the terminal, policy matrix, kill switch.
 *
 * Every recipe, tool id and path here is synthetic.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLAG_ENFORCE_POLICY,
  KILL_SWITCH_WRITES,
  setFlag,
} from "../../featureFlags.js";
import { _setKillSwitchReaderForTesting } from "../../governance/killSwitchPolicy.js";
import { _resetActiveProfileForTesting } from "../../governance/profile.js";
import { clearConfigCache } from "../../patchworkConfig.js";
import {
  type RegisteredTool,
  registerTool,
} from "../../recipes/toolRegistry.js";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import "../../recipes/tools/index.js";
import { runRecord, runTest } from "../recipe.js";

let home: string;
const savedHome = process.env.PATCHWORK_HOME;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-test-record-"));
  process.env.PATCHWORK_HOME = home;
  clearConfigCache();
  _resetActiveProfileForTesting();
  setFlag(KILL_SWITCH_WRITES, false);
  setFlag(FLAG_ENFORCE_POLICY, false, false);
  _setKillSwitchReaderForTesting(null);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = savedHome;
  clearConfigCache();
  _resetActiveProfileForTesting();
  setFlag(KILL_SWITCH_WRITES, false);
  setFlag(FLAG_ENFORCE_POLICY, false, false);
  _setKillSwitchReaderForTesting(null);
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, unknown>): void {
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ model: "claude", ...extra }),
  );
  clearConfigCache();
}

function writeRecipe(name: string, body: string): string {
  const p = path.join(home, `${name}.yaml`);
  writeFileSync(p, body);
  return p;
}

function fakeTool(id: string, isWrite: boolean) {
  const execute = vi.fn(async () => "did-it");
  const [namespace] = id.split(".");
  registerTool({
    id,
    namespace: namespace ?? id,
    description: `fake ${id}`,
    paramsSchema: { type: "object" },
    outputSchema: { type: "string" },
    riskDefault: isWrite ? "high" : "low",
    isWrite,
    execute,
  } as unknown as RegisteredTool);
  return execute;
}

describe("recipe test is evidence-only", () => {
  it("refuses an unmocked write tool instead of running it live", async () => {
    const exec = fakeTool("synthwrite.push", true);
    const p = writeRecipe(
      "unmocked-write",
      [
        "name: unmocked-write",
        "description: synthetic",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - tool: synthwrite.push",
        "    into: pushed",
        "",
      ].join("\n"),
    );
    const r = await runTest(p, { fixturesDir: home });
    expect(exec).not.toHaveBeenCalled();
    expect(r.valid).toBe(false);
    const msg = r.issues.map((i) => i.message).join("\n");
    expect(msg).toMatch(/test_refused_unmocked_step/);
    expect(msg).toMatch(/synthwrite\.push/);
    expect(msg).toMatch(/pushed/);
  });

  it("refuses file.write and does not create the file", async () => {
    const target = path.join(home, "out", "sub", "result.txt");
    const p = writeRecipe(
      "writes-a-file",
      [
        "name: writes-a-file",
        "description: synthetic",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - tool: file.write",
        `    path: ${target}`,
        "    content: hello",
        "    into: written",
        "",
      ].join("\n"),
    );
    const r = await runTest(p, { fixturesDir: home });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(home, "out"))).toBe(false);
    const msg = r.issues.map((i) => i.message).join("\n");
    expect(msg).toMatch(/test_refused_unmocked_step/);
    expect(msg).toMatch(/file\.write/);
  });

  it("an agent step with no injected driver never dispatches under testOnly", async () => {
    const recipe = {
      name: "agent-no-driver",
      trigger: { type: "manual" },
      steps: [
        {
          agent: { driver: "local", prompt: "summarise", into: "summary" },
        },
      ],
    } as unknown as YamlRecipe;
    const run = await runYamlRecipe(recipe, {
      testOnly: true,
      testMode: true,
      workdir: home,
      writeFile: () => {},
      appendFile: () => {},
      mkdir: () => {},
    });
    expect(run.errorMessage ?? "").toMatch(/test_refused_unmocked_step/);
    expect(run.errorMessage ?? "").not.toMatch(/test-guard/);
  });

  it("runTest mocks every agent driver, including local", async () => {
    const p = writeRecipe(
      "agent-local",
      [
        "name: agent-local",
        "description: synthetic",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - agent:",
        "      driver: local",
        "      prompt: summarise",
        "      into: summary",
        "",
      ].join("\n"),
    );
    const r = await runTest(p, { fixturesDir: home });
    const msg = r.issues.map((i) => i.message).join("\n");
    expect(msg).not.toMatch(/test-guard/);
    expect(r.valid).toBe(true);
  });

  it("chained path stays fully mocked: no tool runs for real", async () => {
    const exec = fakeTool("synthwrite.chained", true);
    const p = writeRecipe(
      "chained-mocked",
      [
        "name: chained-mocked",
        "description: synthetic",
        "trigger:",
        "  type: chained",
        "steps:",
        "  - id: one",
        "    tool: synthwrite.chained",
        "",
      ].join("\n"),
    );
    const r = await runTest(p, { fixturesDir: home });
    expect(exec).not.toHaveBeenCalled();
    expect(r.issues.map((i) => i.message).join("\n")).not.toMatch(
      /test_refused_unmocked_step/,
    );
  });
});

describe("recipe record is governed like recipe run --local", () => {
  let seq = 0;
  let toolId = "";
  beforeEach(() => {
    seq++;
    toolId = `synthrec${seq}.push`;
  });
  const writeStepRecipe = () =>
    writeRecipe(
      "record-write",
      [
        "name: record-write",
        "description: synthetic",
        "trigger:",
        "  type: manual",
        "steps:",
        `  - tool: ${toolId}`,
        "    into: pushed",
        "",
      ].join("\n"),
    );

  it("governed: a gated write asks the operator, and 'no' means it never runs", async () => {
    writeConfig({ profile: "governed" });
    const exec = fakeTool(toolId, true);
    const ask = vi.fn(async () => "n");
    const r = await runRecord(writeStepRecipe(), {
      fixturesDir: path.join(home, "fx"),
      io: { isTTY: true, ask },
      deps: { workdir: home },
    });
    expect(ask).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(r.valid).toBe(false);
  });

  it("governed: 'yes' lets the write run", async () => {
    writeConfig({ profile: "governed" });
    const exec = fakeTool(toolId, true);
    const r = await runRecord(writeStepRecipe(), {
      fixturesDir: path.join(home, "fx"),
      io: { isTTY: true, ask: async () => "y" },
      deps: { workdir: home },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.valid).toBe(true);
  });

  it("governed: a forbidden policy path is refused", async () => {
    writeConfig({ profile: "governed" });
    const ws = path.join(home, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      path.join(ws, "patchwork.policy.yml"),
      'version: 1\ndefaults:\n  forbiddenPaths:\n    - "secrets/**"\n',
    );
    const p = writeRecipe(
      "record-forbidden",
      [
        "name: record-forbidden",
        "description: synthetic",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - tool: file.write",
        "    path: secrets/key.txt",
        "    content: x",
        "    into: written",
        "",
      ].join("\n"),
    );
    const writes: string[] = [];
    const r = await runRecord(p, {
      fixturesDir: path.join(home, "fx"),
      io: { isTTY: true, ask: async () => "y" },
      deps: {
        workdir: ws,
        writeFile: (f: string) => {
          writes.push(f);
        },
        mkdir: () => {},
      },
    });
    expect(writes).toEqual([]);
    expect(r.issues.map((i) => i.message).join("\n")).toMatch(/policy_denied/);
  });

  it("kill switch engaged refuses the write", async () => {
    writeConfig({ profile: "governed" });
    const exec = fakeTool(toolId, true);
    setFlag(KILL_SWITCH_WRITES, true);
    const r = await runRecord(writeStepRecipe(), {
      fixturesDir: path.join(home, "fx"),
      io: { isTTY: true, ask: async () => "y" },
      deps: { workdir: home },
    });
    expect(exec).not.toHaveBeenCalled();
    expect(r.issues.map((i) => i.message).join("\n")).toMatch(/kill_switch/);
  });
});
