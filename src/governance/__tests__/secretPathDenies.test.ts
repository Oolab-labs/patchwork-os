/**
 * Agent steps must not read the runtime's own secret stores.
 *
 * The runtime keeps operator-supplied connector client secrets in
 * `<home>/.secrets.json`, and encrypted connector tokens together with the
 * key that decrypts them under `<home>/tokens/`. A governed agent step is
 * contained to Read/Glob/Grep/LS — read-only, but not read-restricted — and
 * before this change nothing in the permission config it was spawned with
 * named those paths. These tests assert on the permission config the runtime
 * BUILDS (settings file + argv) on every dispatch path; no model is run.
 */

import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
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
      (mockChild.stdout as { setEncoding?: () => void }).setEncoding = vi.fn();
      (mockChild.stderr as { setEncoding?: () => void }).setEncoding = vi.fn();
      setTimeout(() => {
        mockChild.stdout.emit(
          "data",
          `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
        );
        mockChild.emit("close", 0);
      }, 0);
      return mockChild;
    }),
  };
});

import { spawn } from "node:child_process";
import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import { SubprocessDriver } from "../../drivers/claude/subprocess.js";
import type { IClaudeDriver } from "../../drivers/types.js";
import { defaultClaudeCodeFn } from "../../recipes/yamlRunner.js";
import {
  COMPAT_PROFILE,
  GOVERNED_PROFILE,
  resolveAgentContainment,
} from "../profile.js";
import {
  secretPathDenyRules,
  toAbsoluteRulePath,
} from "../secretPathDenies.js";

const spawnMock = vi.mocked(spawn);
const POSIX = process.platform !== "win32";

let home: string;
let claudeDir: string;

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
function settingsDeny(args: string[]): string[] {
  const p = flagValues(args, "--settings")[0];
  expect(p).toBeTruthy();
  const s = JSON.parse(readFileSync(p as string, "utf8")) as {
    permissions?: { deny?: string[] };
  };
  return s.permissions?.deny ?? [];
}
function rule(...segs: string[]): string {
  return `Read(${toAbsoluteRulePath(path.join(...segs))})`;
}
function expectedReadDenies(): string[] {
  return [
    rule(home, ".secrets.json"),
    rule(home, "tokens", "**"),
    rule(home, "credentials.json"),
    rule(claudeDir, ".credentials.json"),
  ];
}
/** Both layers: the settings file AND --disallowed-tools. */
function expectSecretsDenied(args: string[]) {
  expect(settingsDeny(args)).toEqual(
    expect.arrayContaining(expectedReadDenies()),
  );
  expect(flagValues(args, "--disallowed-tools")).toEqual(
    expect.arrayContaining(expectedReadDenies()),
  );
}

beforeEach(() => {
  spawnMock.mockClear();
  home = mkdtempSync(path.join(os.tmpdir(), "pw-secret-home-"));
  claudeDir = mkdtempSync(path.join(os.tmpdir(), "pw-secret-claude-"));
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

describe("secretPathDenyRules", () => {
  it("names the secret stores under the active home, as absolute rules", () => {
    const rules = secretPathDenyRules();
    expect(rules).toEqual(expect.arrayContaining(expectedReadDenies()));
    expect(rules).toContain(
      `Edit(${toAbsoluteRulePath(path.join(home, "tokens", "**"))})`,
    );
    for (const r of rules) expect(r).toMatch(/^(Read|Edit)\(\/\//);
  });

  it("covers an overridden token directory", () => {
    const dir = path.join(home, "elsewhere");
    vi.stubEnv("PATCHWORK_TOKEN_DIR", dir);
    expect(secretPathDenyRules()).toContain(rule(dir, "**"));
  });

  it("converts a Windows drive path to the CLI's POSIX form", () => {
    expect(toAbsoluteRulePath("C:\\Users\\a\\.patchwork\\tokens\\**")).toBe(
      "//c/Users/a/.patchwork/tokens/**",
    );
    expect(toAbsoluteRulePath("/home/a/.patchwork/.secrets.json")).toBe(
      "//home/a/.patchwork/.secrets.json",
    );
  });
});

describe("subprocess driver (flat runner, chained runner, orchestrator)", () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    prompt: "summarise",
    workspace: home,
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...extra,
  });

  it("governed contained step: secret stores are denied", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const d = new SubprocessDriver("claude", "ant", () => {});
    await d.run(input({ containment }));
    expectSecretsDenied(spawnMock.mock.calls[0]![1] as string[]);
  });

  it("a step's own tools: naming a secret path does not lift the deny", async () => {
    const secretRead = rule(home, ".secrets.json");
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      allowedTools: [secretRead, "Read"],
    });
    const d = new SubprocessDriver("claude", "ant", () => {});
    await d.run(input({ containment }));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expectSecretsDenied(args);
    expect(flagValues(args, "--disallowed-tools")).toContain(secretRead);
  });

  it("compat, uncontained: secret stores are still denied", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, undefined);
    const d = new SubprocessDriver("claude", "ant", () => {});
    await d.run(input({ containment }));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    expectSecretsDenied(args);
  });

  it("compat sandbox opt-in: secret stores are still denied", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, {
      sandbox: true,
      allowedTools: ["Read"],
    });
    const d = new SubprocessDriver("claude", "ant", () => {});
    await d.run(input({ containment }));
    expectSecretsDenied(spawnMock.mock.calls[0]![1] as string[]);
  });

  it("orchestrator task (contained in _enqueueWithId): secret stores are denied", async () => {
    const d = new SubprocessDriver("claude", "ant", () => {});
    const orch = new ClaudeOrchestrator(
      d as unknown as IClaudeDriver,
      home,
      () => {},
    );
    const task = await orch.runAndWait({ prompt: "summarise" });
    expect(task.status).toBe("done");
    expectSecretsDenied(spawnMock.mock.calls[0]![1] as string[]);
  });
});

describe.skipIf(!POSIX)("recipe run --local (defaultClaudeCodeFn)", () => {
  let binDir: string;
  let argvFile: string;
  beforeEach(() => {
    binDir = mkdtempSync(path.join(os.tmpdir(), "pw-secret-bin-"));
    argvFile = path.join(binDir, "argv.txt");
    const fake = path.join(binDir, "claude");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho fake-reply\n`,
    );
    chmodSync(fake, 0o755);
    vi.stubEnv("PATCHWORK_CLAUDE_BINARY", fake);
    vi.stubEnv("PATCHWORK_WORKSPACE", home);
  });
  afterEach(() => rmSync(binDir, { recursive: true, force: true }));
  const argv = () => readFileSync(argvFile, "utf8").split("\n").slice(0, -1);

  it("governed contained: secret stores are denied", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    expect(await defaultClaudeCodeFn("x", { containment })).toBe("fake-reply");
    expectSecretsDenied(argv());
  });

  it("compat, no containment: secret stores are denied on the argv", async () => {
    expect(await defaultClaudeCodeFn("x")).toBe("fake-reply");
    expect(flagValues(argv(), "--disallowed-tools")).toEqual(
      expect.arrayContaining(expectedReadDenies()),
    );
  });
});
