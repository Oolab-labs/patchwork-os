import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let lastSpawnEnv: NodeJS.ProcessEnv | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        lastSpawnEnv = opts?.env;
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter & { setEncoding: () => void };
          stderr: EventEmitter & { setEncoding: () => void };
          pid: number;
        };
        child.stdout = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
        });
        child.stderr = Object.assign(new EventEmitter(), {
          setEncoding: vi.fn(),
        });
        child.pid = 4242;
        setTimeout(() => child.emit("close", 0), 0);
        return child;
      },
    ),
  };
});
vi.mock("../../../processTree.js", () => ({ treeKill: vi.fn() }));

import { spawn } from "node:child_process";
import {
  COMPAT_PROFILE,
  GOVERNED_PROFILE,
  resolveAgentContainment,
} from "../../../governance/profile.js";
import type { ProviderTaskInput } from "../../types.js";
import { CodexDriver } from "../subprocess.js";

function makeInput(o: Partial<ProviderTaskInput> = {}): ProviderTaskInput {
  return {
    prompt: "hi",
    workspace: "/tmp",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...o,
  };
}
function valuesAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  return out;
}

describe("CodexDriver — coarse containment", () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    vi.stubEnv("JIRA_API_TOKEN", "jira-secret");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIG_ENV);
  });

  it("governed: read-only sandbox forced even when the step escalates; no network; allowlisted env", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const driver = new CodexDriver("codex", vi.fn());
    await driver.run(
      makeInput({
        containment,
        providerOptions: {
          sandboxMode: "danger-full-access",
          networkAccess: true,
          webSearch: true,
        },
      }),
    );
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(valuesAfter(args, "--sandbox")).toEqual(["read-only"]);
    expect(valuesAfter(args, "-c")).toContain("sandbox.network_access=false");
    expect(args).not.toContain("--search");
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBeUndefined();
    expect(lastSpawnEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(lastSpawnEnv?.OPENAI_API_KEY).toBe("sk-openai");
  });

  it("governed + network widened: the step's networkAccess/webSearch are honoured", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      network: true,
    });
    const driver = new CodexDriver("codex", vi.fn());
    await driver.run(
      makeInput({
        containment,
        providerOptions: { networkAccess: true, webSearch: true },
      }),
    );
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(valuesAfter(args, "-c")).toContain("sandbox.network_access=true");
    expect(args).toContain("--search");
    expect(valuesAfter(args, "--sandbox")).toEqual(["read-only"]);
  });

  it("compat: step escalation honoured as before", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, undefined);
    const driver = new CodexDriver("codex", vi.fn());
    await driver.run(
      makeInput({
        containment,
        providerOptions: { sandboxMode: "workspace-write" },
      }),
    );
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(valuesAfter(args, "--sandbox")).toEqual(["workspace-write"]);
    expect(lastSpawnEnv?.JIRA_API_TOKEN).toBe("jira-secret");
  });
});
