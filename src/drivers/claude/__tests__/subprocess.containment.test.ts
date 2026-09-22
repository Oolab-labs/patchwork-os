import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
}

let mockChild: MockChild;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
let capturedMcpConfig: string | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { readFileSync } = await import("node:fs");
  return {
    ...original,
    spawn: vi.fn(
      (_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        lastSpawnEnv = opts?.env;
        const idx = args.indexOf("--mcp-config");
        capturedMcpConfig =
          idx === -1 ? undefined : readFileSync(args[idx + 1]!, "utf-8");
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

import { spawn } from "node:child_process";
import {
  COMPAT_PROFILE,
  GOVERNED_PROFILE,
  resolveAgentContainment,
} from "../../../governance/profile.js";
import type { ProviderTaskInput } from "../../types.js";
import { containmentFromInput, SubprocessDriver } from "../subprocess.js";

const spawnMock = vi.mocked(spawn);

function makeInput(
  overrides: Partial<ProviderTaskInput> = {},
): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: "/workspace/contained",
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

function valuesAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  const i = args.indexOf(flag);
  if (i === -1) return out;
  for (let j = i + 1; j < args.length && !args[j]!.startsWith("--"); j++) {
    out.push(args[j]!);
  }
  return out;
}

const bridge = () => ({ url: "http://127.0.0.1:3101/mcp", authToken: "t" });

describe("SubprocessDriver — governed containment argv", () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    spawnMock.mockClear();
    lastSpawnEnv = undefined;
    capturedMcpConfig = undefined;
    vi.stubEnv("JIRA_API_TOKEN", "jira-secret");
    vi.stubEnv("PATCHWORK_HOME", "/x");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIG_ENV);
  });

  it("governed default: dontAsk + read-only allowlist + WebFetch/WebSearch/Bash denied, no skip-permissions", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(driver.run(makeInput({ containment })));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(valuesAfter(args, "--permission-mode")).toEqual(["dontAsk"]);
    expect(valuesAfter(args, "--allowed-tools").sort()).toEqual(
      ["Glob", "Grep", "LS", "Read"].sort(),
    );
    const denied = valuesAfter(args, "--disallowed-tools");
    expect(denied).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch", "Bash"]),
    );
    // Settings file for a contained run carries the same denials.
    const settingsPath = valuesAfter(args, "--settings")[0]!;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions: { deny: string[] };
    };
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch", "Bash", "Bash(curl *)"]),
    );
    // No MCP config: mcpAccess defaults to false under containment.
    expect(args).not.toContain("--mcp-config");
  });

  it("governed default: allowlisted environment — secrets dropped, provider credential kept", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(driver.run(makeInput({ containment })));
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBeUndefined();
    expect(lastSpawnEnv?.PATCHWORK_HOME).toBeUndefined();
    expect(lastSpawnEnv?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(lastSpawnEnv?.PATH).toBe(process.env.PATH);
  });

  it("governed + passEnv: a declared key reaches the child", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(
      driver.run(
        makeInput({
          containment,
          providerOptions: { passEnv: ["JIRA_API_TOKEN"] },
        }),
      ),
    );
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBe("jira-secret");
    expect(lastSpawnEnv?.PATCHWORK_HOME).toBeUndefined();
  });

  it("widening network: true removes WebFetch/WebSearch from deny and reports it", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      network: true,
    });
    expect(containment.widenings).toEqual(["network"]);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(driver.run(makeInput({ containment })));
    const args = spawnMock.mock.calls[0]![1] as string[];
    const denied = valuesAfter(args, "--disallowed-tools");
    expect(denied).not.toContain("WebFetch");
    expect(denied).not.toContain("WebSearch");
    expect(denied).toContain("Bash");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("mcpAccess false under containment ⇒ no MCP config written even if the legacy key says true", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(
      driver.run(
        makeInput({ containment, providerOptions: { mcpAccess: true } }),
      ),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--mcp-config");
    expect(capturedMcpConfig).toBeUndefined();
  });

  it("mcpAccess widened ⇒ MCP config written, reported as a widening, and cleaned up on close", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      mcpAccess: true,
    });
    expect(containment.widenings).toContain("mcpAccess");
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(driver.run(makeInput({ containment })));
    const args = spawnMock.mock.calls[0]![1] as string[];
    const cfgPath = valuesAfter(args, "--mcp-config")[0]!;
    expect(capturedMcpConfig).toContain('"--port","3101"');
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("compat with no sandbox: legacy args unchanged (skip-permissions, denylist env)", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, undefined);
    expect(containment.enforced).toBe(false);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(driver.run(makeInput({ containment })));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--disallowed-tools");
    // Denylist mode: an unrelated connector token still reaches the child
    // (today's behaviour — the allowlist is governed-only).
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBe("jira-secret");
  });

  it("compat with sandbox: true reproduces the legacy allowlist branch via containment", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, {
      sandbox: true,
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    });
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(driver.run(makeInput({ containment })));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(valuesAfter(args, "--allowed-tools")).toEqual(["Read"]);
    expect(valuesAfter(args, "--disallowed-tools")).toEqual(["Bash"]);
  });

  it("reads the containment from providerOptions.containment (orchestrator hop)", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new SubprocessDriver("claude", "ant", vi.fn(), bridge);
    await finishRun(
      driver.run(makeInput({ providerOptions: { containment } })),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(valuesAfter(args, "--permission-mode")).toEqual(["dontAsk"]);
  });

  it("containmentFromInput ignores a malformed object rather than half-applying it", () => {
    expect(
      containmentFromInput({ providerOptions: { containment: { foo: 1 } } }),
    ).toBeUndefined();
    expect(containmentFromInput({ providerOptions: {} })).toBeUndefined();
  });
});
