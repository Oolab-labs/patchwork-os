import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  pid = 4242;
  signalCode: NodeJS.Signals | null = null;
}

let mockChild: MockChild;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        lastSpawnEnv = opts?.env;
        mockChild = new MockChild();
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();
        (mockChild.stdout as { setEncoding?: () => void }).setEncoding =
          vi.fn();
        (mockChild.stderr as { setEncoding?: () => void }).setEncoding =
          vi.fn();
        return mockChild;
      },
    ),
  };
});

const { treeKillMock } = vi.hoisted(() => ({ treeKillMock: vi.fn() }));
vi.mock("../../../processTree.js", () => ({ treeKill: treeKillMock }));

import { spawn } from "node:child_process";
import type { ProviderTaskInput } from "../../types.js";
import { CodexDriver } from "../subprocess.js";

const spawnMock = vi.mocked(spawn);

function makeInput(
  overrides: Partial<ProviderTaskInput> = {},
): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: "/workspace/codex-test",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function finishRun(
  p: Promise<unknown>,
  events: string[] = [
    JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "ok" },
    }),
  ],
): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  for (const e of events) mockChild.stdout.emit("data", `${e}\n`);
  mockChild.emit("close", 0);
  await p;
}

function valuesAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const v = args[i + 1];
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

function newDriver() {
  return new CodexDriver("codex", vi.fn());
}

describe("CodexDriver: fail-closed defaults (no providerOptions)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the full restrictive flag set with no opt-in", async () => {
    const driver = newDriver();
    await finishRun(driver.run(makeInput()));
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("--ask-for-approval");
    expect(args[args.indexOf("--ask-for-approval") + 1]).toBe("never");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ephemeral");
    expect(valuesAfter(args, "-c")).toContain("sandbox.network_access=false");
  });

  it("does not pass --search by default (web search stays at Codex's own default)", async () => {
    const driver = newDriver();
    await finishRun(driver.run(makeInput()));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--search");
  });

  it("uses detached:true + process.signal wiring so treeKill can reach the whole process group", async () => {
    const driver = newDriver();
    await finishRun(driver.run(makeInput()));
    const spawnOpts = spawnMock.mock.calls[0]![2] as { detached?: boolean };
    expect(spawnOpts.detached).toBe(true);
  });
});

describe("CodexDriver: explicit escalation via providerOptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("escalates sandboxMode when explicitly requested", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({ providerOptions: { sandboxMode: "workspace-write" } }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("rejects an unrecognized sandboxMode value and falls back to the safe default", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({ providerOptions: { sandboxMode: "not-a-real-mode" } }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("escalates approvalMode when explicitly requested", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({ providerOptions: { approvalMode: "on-request" } }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--ask-for-approval") + 1]).toBe("on-request");
  });

  it("enables network access only when explicitly requested", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(makeInput({ providerOptions: { networkAccess: true } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(valuesAfter(args, "-c")).toContain("sandbox.network_access=true");
  });

  it("passes --search only when webSearch is explicitly requested", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(makeInput({ providerOptions: { webSearch: true } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--search");
  });
});

describe("CodexDriver: argv injection guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a prompt starting with '-' before spawning", async () => {
    const driver = newDriver();
    await expect(driver.run(makeInput({ prompt: "-rf /" }))).rejects.toThrow(
      /argv injection guard/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("CodexDriver: NDJSON stream handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accumulates agent_message text across multiple item.completed events", async () => {
    const driver = newDriver();
    const result = await (async () => {
      const p = driver.run(makeInput());
      await finishRun(p, [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "i1", type: "agent_message", text: "Hello, " },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "i2", type: "agent_message", text: "world." },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ]);
      return p;
    })();
    expect(result.text).toBe("Hello, world.");
    expect(result.exitCode).toBe(0);
    expect(result.providerMeta?.inputTokens).toBe(10);
    expect(result.providerMeta?.outputTokens).toBe(5);
  });

  it("ignores item.completed text from non-agent_message items (e.g. command execution)", async () => {
    const driver = newDriver();
    const p = driver.run(makeInput());
    await finishRun(p, [
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "i1",
          type: "command_execution",
          command: "ls",
          status: "ok",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i2", type: "agent_message", text: "done" },
      }),
    ]);
    const result = await p;
    expect(result.text).toBe("done");
  });

  it("surfaces an error event as errorMessage and exitCode 1, even when the process itself exits 0", async () => {
    const driver = newDriver();
    const p = driver.run(makeInput());
    await finishRun(p, [
      JSON.stringify({ type: "error", message: "sandbox denied write" }),
    ]);
    const result = await p;
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("sandbox denied write");
  });

  it("treats turn.failed the same as an error event", async () => {
    const driver = newDriver();
    const p = driver.run(makeInput());
    await finishRun(p, [
      JSON.stringify({ type: "turn.failed", message: "model overloaded" }),
    ]);
    const result = await p;
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("model overloaded");
  });

  it("does not crash on a non-JSON stray line, treating it as raw passthrough text", async () => {
    const driver = newDriver();
    const p = driver.run(makeInput());
    await finishRun(p, [
      "not valid json",
      JSON.stringify({
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "still works" },
      }),
    ]);
    const result = await p;
    expect(result.text).toContain("still works");
  });
});

describe("CodexDriver: cancellation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls treeKill (process-group kill, not direct-child-only) on abort", async () => {
    const driver = newDriver();
    const controller = new AbortController();
    const p = driver.run(makeInput({ signal: controller.signal }));
    await new Promise<void>((r) => setTimeout(r, 0));
    controller.abort();
    expect(treeKillMock).toHaveBeenCalledWith(mockChild);
    mockChild.emit("close", -1);
    await p;
  });
});

describe("CodexDriver: env sanitization", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("does not need OPENAI_API_KEY preserved for the default subscription-auth path — it is stripped like any other cross-provider secret", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-should-be-stripped");
    const driver = newDriver();
    await finishRun(driver.run(makeInput()));
    expect(lastSpawnEnv?.OPENAI_API_KEY).toBeUndefined();
  });
});
