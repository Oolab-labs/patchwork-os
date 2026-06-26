import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
}

let mockChild: MockChild;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      mockChild = new MockChild();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      (mockChild.stdout as { setEncoding?: () => void }).setEncoding = vi.fn();
      (mockChild.stderr as { setEncoding?: () => void }).setEncoding = vi.fn();
      return mockChild;
    }),
  };
});

import { spawn } from "node:child_process";
import type { ProviderTaskInput } from "../../types.js";
import { SubprocessDriver } from "../subprocess.js";

const spawnMock = vi.mocked(spawn);

function makeInput(
  overrides: Partial<ProviderTaskInput> = {},
): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: "/workspace/sandbox",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function finishRun(p: Promise<unknown>): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  mockChild.stdout.emit(
    "data",
    `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
  );
  mockChild.emit("close", 0);
  await p;
}

/** Collect the values that follow each occurrence of `flag` in argv. */
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

describe("SubprocessDriver opt-in tool sandbox (P0-5)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  function newDriver() {
    return new SubprocessDriver("claude", "ant", vi.fn());
  }

  it("sandbox + allowlist ⇒ enforces --permission-mode dontAsk + --allowed-tools and DROPS skip-permissions", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({
          providerOptions: {
            sandbox: true,
            allowedTools: ["getDiagnostics", "getGitStatus"],
          },
        }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--allowed-tools");
    // Variadic: one flag, both values follow it.
    expect(valuesAfter(args, "--allowed-tools")).toEqual(["getDiagnostics"]);
    const flagIdx = args.indexOf("--allowed-tools");
    expect(args.slice(flagIdx + 1, flagIdx + 3)).toEqual([
      "getDiagnostics",
      "getGitStatus",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("sandbox off (no providerOptions) ⇒ byte-identical default: skip-permissions, no sandbox flags", async () => {
    const driver = newDriver();
    await finishRun(driver.run(makeInput()));
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--disallowed-tools");
  });

  it("sandbox: true but EMPTY allowlist ⇒ falls back to skip-permissions (sandboxActive guard requires non-empty)", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({ providerOptions: { sandbox: true, allowedTools: [] } }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--permission-mode");
  });

  it("disallowedTools applies in DEFAULT mode (alongside skip-permissions)", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({ providerOptions: { disallowedTools: ["runCommand"] } }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--disallowed-tools");
    expect(valuesAfter(args, "--disallowed-tools")).toEqual(["runCommand"]);
  });

  it("disallowedTools applies UNDER sandbox (with allowed-tools, no skip-permissions)", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({
          providerOptions: {
            sandbox: true,
            allowedTools: ["getGitStatus"],
            disallowedTools: ["runCommand"],
          },
        }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(valuesAfter(args, "--allowed-tools")).toEqual(["getGitStatus"]);
    expect(valuesAfter(args, "--disallowed-tools")).toEqual(["runCommand"]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("drops leading-dash tool values (argv-injection guard) in allowlist and denylist", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({
          providerOptions: {
            sandbox: true,
            allowedTools: ["--evil", "getDiagnostics"],
            disallowedTools: ["-x", "runCommand"],
          },
        }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];

    expect(args).not.toContain("--evil");
    expect(args).not.toContain("-x");
    expect(valuesAfter(args, "--allowed-tools")).toEqual(["getDiagnostics"]);
    expect(valuesAfter(args, "--disallowed-tools")).toEqual(["runCommand"]);
  });

  it("sandbox where every allowed tool is leading-dash ⇒ FILTERED list empty ⇒ falls back to skip-permissions", async () => {
    const driver = newDriver();
    await finishRun(
      driver.run(
        makeInput({
          providerOptions: { sandbox: true, allowedTools: ["--a", "--b"] },
        }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];

    // The branch keys off the FILTERED allowlist being non-empty (argv-injection
    // facts): all values are leading-dash → filtered list empty → not sandbox-
    // active → default skip-permissions path, no allowlist flag/values leak.
    expect(args).not.toContain("--a");
    expect(args).not.toContain("--b");
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("--dangerously-skip-permissions");
  });
});
