/**
 * Phase 0 acceptance — scenario 8: containment for orchestrator dispatch.
 *
 * Recipe agent steps resolve their containment in the runner. Everything
 * else that reaches a Claude subprocess goes through `ClaudeOrchestrator`
 * (automation hooks, `runClaudeTask`, `resumeClaudeTask`, recipe generation
 * and repair, prompt recipes, restored tasks). Under the governed profile
 * those must be contained by default too, resolved once at the
 * orchestrator's single enqueue chokepoint so a new call site cannot forget.
 *
 * Exercised with the REAL orchestrator and the REAL subprocess driver; only
 * `spawn` is mocked, so the assertions are on the argv and env a child would
 * actually get.
 *
 * Invariants:
 *   - governed, no containment supplied: no --dangerously-skip-permissions,
 *     WebFetch/WebSearch/Bash denied, only read-only tools allowed, an
 *     unrelated env secret not inherited. Same through `runAndWait` and
 *     through the `runClaudeTask` tool.
 *   - nothing a caller passes widens an orchestrator task under governed —
 *     not `allowedTools`, `sandbox` or `mcpAccess` (this path has no approval
 *     step to justify a widening); the bridge MCP surface stays off.
 *   - a containment the caller resolved itself (a recipe step) is kept as is.
 *   - compat: byte-identical to before — no containment, skip-permissions.
 */

import { EventEmitter } from "node:events";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  exitCode: number | null = null;
  kill = vi.fn();
}
let children: MockChild[] = [];
const spawnEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        spawnEnvs.push(opts?.env);
        const child = new MockChild();
        (child.stdout as { setEncoding?: () => void }).setEncoding = vi.fn();
        (child.stderr as { setEncoding?: () => void }).setEncoding = vi.fn();
        children.push(child);
        return child;
      },
    ),
  };
});

import { spawn } from "node:child_process";
import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import { SubprocessDriver } from "../../drivers/claude/subprocess.js";
import {
  CONTAINED_AGENT_ALLOWED_TOOLS,
  GOVERNED_PROFILE,
  resolveAgentContainment,
} from "../../governance/profile.js";
import { createRunClaudeTaskTool } from "../../tools/runClaudeTask.js";
import { governed, makeSandbox, resetGovernanceState } from "./_harness.js";

const sandbox = makeSandbox("orch-containment");
afterAll(() => sandbox.dispose());

function makeOrchestrator(): ClaudeOrchestrator {
  const driver = new SubprocessDriver("claude", "ant", vi.fn(), () => ({
    url: "http://127.0.0.1:3101/mcp",
    authToken: "t",
  }));
  return new ClaudeOrchestrator(driver, sandbox.dir, vi.fn());
}

/** Wait for this test's (single) spawned child, finish it, return its argv and env. */
async function finishNextSpawn(): Promise<{
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}> {
  for (let i = 0; i < 400 && children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(children).toHaveLength(1);
  const child = children[0] as MockChild;
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
  );
  child.exitCode = 0;
  child.emit("close", 0);
  const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
  return { args, env: spawnEnvs[0] };
}

/** Values following a variadic flag, up to the next `--flag`. */
function flagValues(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (const a of args.slice(i + 1)) {
    if (a.startsWith("--")) break;
    out.push(a);
  }
  return out;
}

function expectContained(args: string[], env: NodeJS.ProcessEnv | undefined) {
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(flagValues(args, "--permission-mode")).toEqual(["dontAsk"]);
  expect(flagValues(args, "--disallowed-tools")).toEqual(
    expect.arrayContaining([
      "WebFetch",
      "WebSearch",
      "Bash",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
    ]),
  );
  // Only the operator's user settings: a workspace's own settings can carry
  // hooks and allow rules.
  expect(flagValues(args, "--setting-sources")).toEqual(["user"]);
  for (const t of flagValues(args, "--allowed-tools")) {
    expect(CONTAINED_AGENT_ALLOWED_TOOLS).toContain(t);
  }
  // Positive control: the child did get an explicit, filtered env (an absent
  // env would inherit everything and make the line below pass vacuously).
  expect(env?.PATH).toBeTruthy();
  expect(env?.ORCH_TEST_UNRELATED_SECRET).toBeUndefined();
  // No bridge MCP surface unless something widened it — nothing here can.
  expect(args).not.toContain("--mcp-config");
}

async function waitDone(orch: ClaudeOrchestrator, id: string) {
  for (let i = 0; i < 200; i++) {
    const s = orch.getTask(id)?.status;
    if (s && s !== "pending" && s !== "running") return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  resetGovernanceState();
  vi.mocked(spawn).mockClear();
  children = [];
  spawnEnvs.length = 0;
  vi.stubEnv("ORCH_TEST_UNRELATED_SECRET", "must-not-be-inherited");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetGovernanceState();
});

describe("governed: orchestrator dispatch is contained by default", () => {
  it("enqueue with no containment → contained argv and env", async () => {
    governed();
    const orch = makeOrchestrator();
    const id = orch.enqueue({ prompt: "summarise the repo", sessionId: "s" });
    expect(orch.getTask(id)?.containment?.enforced).toBe(true);
    const { args, env } = await finishNextSpawn();
    expectContained(args, env);
    await waitDone(orch, id);
  });

  it("runAndWait with no containment → contained", async () => {
    governed();
    const orch = makeOrchestrator();
    const done = orch.runAndWait({ prompt: "summarise", sessionId: "s" });
    const { args, env } = await finishNextSpawn();
    expectContained(args, env);
    const task = await done;
    expect(task.containment?.enforced).toBe(true);
  });

  it("the runClaudeTask tool → contained", async () => {
    governed();
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "s", sandbox.dir);
    const res = (await tool.handler({
      prompt: "look at the failing test",
    })) as {
      isError?: boolean;
    };
    expect(res.isError).not.toBe(true);
    const { args, env } = await finishNextSpawn();
    expectContained(args, env);
  });

  it("a caller's mcpAccess is not honoured: no bridge MCP, no widening", async () => {
    governed();
    const orch = makeOrchestrator();
    const id = orch.enqueue({ prompt: "x", sessionId: "s", mcpAccess: true });
    const c = orch.getTask(id)?.containment;
    expect(c?.enforced).toBe(true);
    expect(c?.mcpAccess).toBe(false);
    expect(c?.widenings ?? []).toEqual([]);
    const { args, env } = await finishNextSpawn();
    expectContained(args, env);
    await waitDone(orch, id);
  });

  it("caller allowedTools/sandbox do not widen an orchestrator task", async () => {
    governed();
    const orch = makeOrchestrator();
    const id = orch.enqueue({
      prompt: "x",
      sessionId: "s",
      sandbox: true,
      allowedTools: ["Edit", "Write", "Bash"],
    });
    const { args, env } = await finishNextSpawn();
    expectContained(args, env);
    for (const t of ["Edit", "Write", "Bash"]) {
      expect(flagValues(args, "--allowed-tools")).not.toContain(t);
    }
    expect(orch.getTask(id)?.containment?.widenings ?? []).toEqual([]);
    await waitDone(orch, id);
  });

  it("a containment the caller resolved itself is kept as is", async () => {
    governed();
    const orch = makeOrchestrator();
    const own = resolveAgentContainment(GOVERNED_PROFILE, { network: true });
    const id = orch.enqueue({ prompt: "x", sessionId: "s", containment: own });
    expect(orch.getTask(id)?.containment).toEqual(own);
    const { args } = await finishNextSpawn();
    expect(args).not.toContain("--dangerously-skip-permissions");
    // The recipe's network widening survived: web tools are not denied.
    expect(flagValues(args, "--disallowed-tools")).not.toContain("WebFetch");
    expect(flagValues(args, "--disallowed-tools")).toContain("Bash");
    await waitDone(orch, id);
  });
});

describe("compat: unchanged", () => {
  it("no containment is added and the child is spawned as before", async () => {
    const orch = makeOrchestrator();
    const id = orch.enqueue({ prompt: "x", sessionId: "s" });
    expect(orch.getTask(id)?.containment).toBeUndefined();
    const { args } = await finishNextSpawn();
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--setting-sources");
    await waitDone(orch, id);
  });
});
