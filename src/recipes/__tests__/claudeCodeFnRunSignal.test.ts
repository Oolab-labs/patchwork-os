/**
 * Both runners hand the run's cancellation signal to the Claude CLI agent
 * call (audit M26).
 *
 * `defaultClaudeCodeFn` can only stop an agent on cancel if the run's signal
 * reaches it. Before, neither runner passed one: the flat runner's cancel
 * took effect "before the next step", and the chained runner's raced the
 * step and ignored its result — in both, the `claude -p` process kept running
 * to completion after the run was cancelled.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(os.tmpdir(), "pw-m26-signal-"));
  prevHome = process.env.PATCHWORK_HOME;
  // PATCHWORK_HOME, not a spy on `os.homedir`: a namespace spy misses named
  // imports and has previously let a test write to the developer's real store.
  process.env.PATCHWORK_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const agentStep = {
  id: "think",
  agent: {
    prompt: "hi",
    driver: "claude-code",
    data_policy: { classification: "public" },
  },
};

function baseDeps(seen: Array<AbortSignal | undefined>) {
  return {
    testMode: true,
    logDir: home,
    readFile: () => {
      throw new Error("nope");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
    claudeFn: async () => "ok",
    claudeCodeFn: async (_p: string, opts?: { signal?: AbortSignal }) => {
      seen.push(opts?.signal);
      return "ok";
    },
  };
}

describe("the run's cancel signal reaches the Claude CLI agent call", () => {
  it("FLAT runner", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const ac = new AbortController();
    const { runYamlRecipe } = await import("../yamlRunner.js");
    await runYamlRecipe(
      {
        name: "flat-signal",
        trigger: { type: "manual" },
        steps: [agentStep],
      } as never,
      { ...baseDeps(seen), signal: ac.signal } as never,
    );
    expect(seen.length).toBe(1);
    const s = seen[0];
    expect(s).toBeInstanceOf(AbortSignal);
    // The runner combines the caller's signal with its own cancel handle, so
    // the object differs; what matters is that aborting the caller reaches it.
    ac.abort();
    expect(s?.aborted).toBe(true);
  });

  it("CHAINED runner", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const ac = new AbortController();
    const { runChainedRecipe } = await import("../chainedRunner.js");
    const { buildChainedDeps } = await import("../yamlRunner.js");
    const chainedDeps = buildChainedDeps(
      baseDeps(seen) as never,
      undefined,
      "chained-signal",
    );
    await runChainedRecipe(
      { name: "chained-signal", steps: [agentStep] } as never,
      {
        env: {},
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        signal: ac.signal,
      } as never,
      chainedDeps,
    );
    expect(seen.length).toBe(1);
    const s = seen[0];
    expect(s).toBeInstanceOf(AbortSignal);
    ac.abort();
    expect(s?.aborted).toBe(true);
  });
});
