import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: homedirMock };
});

let capturedSettings: string | undefined;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
let homeDir = "";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  return {
    ...original,
    spawn: vi.fn(
      (_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        lastSpawnEnv = opts?.env;
        const f = join(homeDir, ".gemini", "settings.json");
        capturedSettings = existsSync(f) ? readFileSync(f, "utf-8") : undefined;
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter & { setEncoding: () => void };
          stderr: EventEmitter & { setEncoding: () => void };
          pid: number;
          unref: () => void;
          kill: () => boolean;
        };
        child.stdout = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
        });
        child.stderr = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
        });
        child.pid = 4242;
        child.unref = vi.fn();
        child.kill = vi.fn(() => true);
        setTimeout(() => {
          child.stdout.emit(
            "data",
            `${JSON.stringify({ type: "result", status: "success", stats: {} })}\n`,
          );
          child.emit("close", 0);
        }, 0);
        return child;
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
import { GeminiSubprocessDriver } from "../index.js";

function makeInput(o: Partial<ProviderTaskInput> = {}): ProviderTaskInput {
  return {
    prompt: "hi",
    workspace: "/tmp",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...o,
  };
}

const bridge = () => ({ url: "http://127.0.0.1:3101/mcp", authToken: "tok" });

describe("GeminiSubprocessDriver — coarse containment", () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "gemini-contain-"));
    homedirMock.mockReturnValue(homeDir);
    vi.mocked(spawn).mockClear();
    capturedSettings = undefined;
    vi.stubEnv("JIRA_API_TOKEN", "jira-secret");
    vi.stubEnv("GEMINI_API_KEY", "AIza-test");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oat");
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIG_ENV);
  });

  it("governed default: plan approval mode, web/shell/write tools excluded, no MCP entry, allowlisted env", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new GeminiSubprocessDriver("gemini", vi.fn(), bridge);
    await driver.run(makeInput({ containment }));
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("plan");
    const settings = JSON.parse(capturedSettings ?? "{}") as {
      tools?: { exclude?: string[] };
      mcpServers?: Record<string, unknown>;
    };
    expect(settings.tools?.exclude).toEqual(
      expect.arrayContaining([
        "web_fetch",
        "google_web_search",
        "run_shell_command",
        "write_file",
      ]),
    );
    expect(settings.mcpServers?.["claude-ide-bridge"]).toBeUndefined();
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBeUndefined();
    expect(lastSpawnEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(lastSpawnEnv?.GEMINI_API_KEY).toBe("AIza-test");
  });

  it("widening network keeps web tools; widening shell keeps yolo + shell", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      network: true,
      shell: true,
    });
    const driver = new GeminiSubprocessDriver("gemini", vi.fn(), bridge);
    await driver.run(makeInput({ containment }));
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("yolo");
    const settings = JSON.parse(capturedSettings ?? "{}") as {
      tools?: { exclude?: string[] };
    };
    expect(settings.tools?.exclude).not.toContain("web_fetch");
    expect(settings.tools?.exclude).not.toContain("run_shell_command");
    // The destructive-prefix deny list still applies.
    expect(settings.tools?.exclude).toContain("run_shell_command(curl)");
  });

  it("mcpAccess widened ⇒ bridge MCP entry is injected", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      mcpAccess: true,
    });
    const driver = new GeminiSubprocessDriver("gemini", vi.fn(), bridge);
    await driver.run(makeInput({ containment }));
    const settings = JSON.parse(capturedSettings ?? "{}") as {
      mcpServers?: Record<string, unknown>;
    };
    expect(settings.mcpServers?.["claude-ide-bridge"]).toBeDefined();
  });

  it("compat with no sandbox: yolo, no extra excludes, denylist env", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, undefined);
    const driver = new GeminiSubprocessDriver("gemini", vi.fn());
    await driver.run(makeInput({ containment }));
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("yolo");
    const settings = JSON.parse(capturedSettings ?? "{}") as {
      tools?: { exclude?: string[] };
    };
    expect(settings.tools?.exclude).not.toContain("web_fetch");
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBe("jira-secret");
  });
});
