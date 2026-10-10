/**
 * Phase 0 acceptance — scenario 9: containment on the local run path, and
 * what a governed contained agent may load.
 *
 * 1. `recipe run --local` and `recipe record` spawn the Claude CLI through
 *    `defaultClaudeCodeFn`, not the subprocess driver. Under the governed
 *    profile the runner hands it a resolved containment; it must apply it
 *    exactly as the driver does (one shared `containedPermissionArgs`).
 * 2. A governed (strict) contained run must not be widened by anything outside
 *    the recipe. Each of these was observed against the real CLI:
 *    - a workspace's own Claude settings: its hooks ran shell commands, and
 *      its allow rules re-enabled unlisted tools;
 *    - the CLI's full built-in tool set: tools that need no permission ran
 *      anyway.
 *
 *    So strict runs:
 *    - load only USER settings, merging the workspace's DENY rules in
 *      ourselves;
 *    - restrict the tool set with `--tools` to the allowlist;
 *    - disable all hooks;
 *    - deny the write built-ins. The step's own `tools:` (internally
 *      `allowedTools`) lifts a named write tool, scoped or bare.
 * 3. Compat is byte-identical, including a compat step that opted into
 *    `sandbox: true`.
 *
 * Driven through the real `defaultClaudeCodeFn` (and the real runner) with a
 * fake `claude` script that records its argv and env — no mocks of
 * `node:child_process`. Spawning cases are POSIX only (shell-script binary).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { containedPermissionArgs } from "../../drivers/claude/subprocess.js";
import { createSubprocessSettings } from "../../drivers/claude/subprocessSettings.js";
import {
  COMPAT_PROFILE,
  CONTAINED_AGENT_ALLOWED_TOOLS,
  GOVERNED_PROFILE,
  resolveAgentContainment,
} from "../../governance/profile.js";
import {
  defaultClaudeCodeFn,
  runYamlRecipe,
  type YamlRecipe,
} from "../../recipes/yamlRunner.js";
import {
  baseDeps,
  governed,
  makeSandbox,
  resetGovernanceState,
} from "./_harness.js";

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const POSIX = process.platform !== "win32";
const sandbox = makeSandbox("local-containment");
afterAll(() => sandbox.dispose());

let workspace: string;
let binDir: string;
let argvFile: string;
let envFile: string;

beforeEach(() => {
  resetGovernanceState();
  workspace = mkdtempSync(path.join(os.tmpdir(), "pw-local-ws-"));
  binDir = mkdtempSync(path.join(os.tmpdir(), "pw-local-bin-"));
  argvFile = path.join(binDir, "argv.txt");
  envFile = path.join(binDir, "env.txt");
  const fake = path.join(binDir, "claude");
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nenv > "${envFile}"\necho fake-reply\n`,
  );
  chmodSync(fake, 0o755);
  vi.stubEnv("PATCHWORK_CLAUDE_BINARY", fake);
  vi.stubEnv("PATCHWORK_WORKSPACE", workspace);
  vi.stubEnv("LOCAL_TEST_UNRELATED_SECRET", "must-not-be-inherited");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetGovernanceState();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

function argv(): string[] {
  return readFileSync(argvFile, "utf8").split("\n").slice(0, -1);
}
function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
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
function settingsOf(args: string[]): {
  disableAllHooks?: boolean;
  permissions?: { deny?: string[]; allow?: string[] };
  hooks?: unknown;
} {
  const p = flagValues(args, "--settings")[0];
  expect(p).toBeTruthy();
  return JSON.parse(readFileSync(p as string, "utf8"));
}

function expectStrictLocal(args: string[]) {
  expect(flagValues(args, "--permission-mode")).toEqual(["dontAsk"]);
  expect(flagValues(args, "--setting-sources")).toEqual(["user"]);
  expect(flagValues(args, "--tools")).toEqual([
    CONTAINED_AGENT_ALLOWED_TOOLS.join(","),
  ]);
  expect(flagValues(args, "--disallowed-tools")).toEqual(
    expect.arrayContaining(["WebFetch", "WebSearch", "Bash", ...WRITE_TOOLS]),
  );
  for (const t of flagValues(args, "--allowed-tools")) {
    expect(CONTAINED_AGENT_ALLOWED_TOOLS).toContain(t);
  }
  const s = settingsOf(args);
  expect(s.disableAllHooks).toBe(true);
  expect(s.permissions?.deny).toEqual(
    expect.arrayContaining(["Bash", "WebFetch", ...WRITE_TOOLS]),
  );
  const env = childEnv();
  expect(env.PATH).toBeTruthy();
  expect(env.LOCAL_TEST_UNRELATED_SECRET).toBeUndefined();
}

describe("containedPermissionArgs (shared by the driver and the local path)", () => {
  it("strict: user settings only, the tool SET restricted, denies unioned", () => {
    const c = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const args = containedPermissionArgs(c, ["Read(./secret.txt)"]);
    expect(flagValues(args, "--setting-sources")).toEqual(["user"]);
    expect(flagValues(args, "--tools")).toEqual([
      CONTAINED_AGENT_ALLOWED_TOOLS.join(","),
    ]);
    expect(flagValues(args, "--disallowed-tools")).toEqual(
      expect.arrayContaining(["Read(./secret.txt)", "Bash", ...WRITE_TOOLS]),
    );
  });

  it("a scoped write rule lifts the bare deny and puts the base tool in the set", () => {
    const c = resolveAgentContainment(GOVERNED_PROFILE, {
      allowedTools: ["Edit(src/**)"],
    });
    expect(c.deniedTools).not.toContain("Edit");
    expect(c.widenings).toContain("allowedTools+Edit(src/**)");
    const args = containedPermissionArgs(c);
    expect(flagValues(args, "--allowed-tools")).toContain("Edit(src/**)");
    expect(flagValues(args, "--tools")[0]?.split(",")).toContain("Edit");
    expect(flagValues(args, "--disallowed-tools")).not.toContain("Edit");
  });

  it("bridge MCP tool names never go into the built-in tool set", () => {
    const c = {
      ...resolveAgentContainment(GOVERNED_PROFILE, undefined),
      allowedTools: ["Read", "mcp__bridge__getDiagnostics"],
    };
    expect(flagValues(containedPermissionArgs(c), "--tools")).toEqual(["Read"]);
  });

  it("compat sandbox opt-in: exactly the flags it always had", () => {
    const c = resolveAgentContainment(COMPAT_PROFILE, {
      sandbox: true,
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    });
    expect(containedPermissionArgs(c)).toEqual([
      "--permission-mode",
      "dontAsk",
      "--allowed-tools",
      "Read",
      "--disallowed-tools",
      "Bash",
    ]);
  });
});

describe("contained settings file", () => {
  it("strict: all hooks disabled, extra denies written", () => {
    const s = createSubprocessSettings(() => {}, ["Bash"], { strict: true });
    expect(s.write()).toBe(true);
    const content = JSON.parse(readFileSync(s.path, "utf8"));
    expect(content.disableAllHooks).toBe(true);
    expect(content.permissions.deny).toContain("Bash");
  });
  it("non-strict: unchanged shape (no disableAllHooks key)", () => {
    const s = createSubprocessSettings(() => {}, ["Bash"]);
    expect(s.write()).toBe(true);
    const content = JSON.parse(readFileSync(s.path, "utf8"));
    expect("disableAllHooks" in content).toBe(false);
  });
});

describe.skipIf(!POSIX)("local run path applies governed containment", () => {
  it("defaultClaudeCodeFn with a strict containment → contained argv, settings and env", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    const out = await defaultClaudeCodeFn("summarise", { containment });
    expect(out).toBe("fake-reply");
    expectStrictLocal(argv());
  });

  it("through the real runner: a governed agent step on the local CLI path is contained", async () => {
    const profile = governed();
    const recipe = {
      name: "local-contained",
      trigger: { type: "manual" },
      steps: [
        {
          id: "ask",
          agent: { prompt: "summarise", driver: "claude-code", into: "out" },
        },
      ],
    } as unknown as YamlRecipe;
    await runYamlRecipe(
      recipe,
      baseDeps(sandbox, {
        governance: profile,
        claudeCodeFn: defaultClaudeCodeFn,
      }),
    );
    expect(existsSync(argvFile)).toBe(true);
    expectStrictLocal(argv());
  });

  it("the workspace's own deny rules still apply; its allows and hooks do not", async () => {
    mkdirSync(path.join(workspace, ".claude"));
    writeFileSync(
      path.join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Read(./secret.txt)"], allow: ["Write"] },
        hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] },
      }),
    );
    writeFileSync(
      path.join(workspace, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { deny: ["Grep(./private/**)"] } }),
    );
    const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    await defaultClaudeCodeFn("x", { containment });
    const args = argv();
    expect(flagValues(args, "--disallowed-tools")).toEqual(
      expect.arrayContaining(["Read(./secret.txt)", "Grep(./private/**)"]),
    );
    const s = settingsOf(args);
    expect(s.permissions?.deny).toEqual(
      expect.arrayContaining(["Read(./secret.txt)", "Grep(./private/**)"]),
    );
    expect(s.permissions?.allow ?? []).not.toContain("Write");
    expect(flagValues(args, "--allowed-tools")).not.toContain("Write");
    expect(flagValues(args, "--setting-sources")).toEqual(["user"]);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "refuses, rather than running uncontained, when the settings file cannot be written",
    async () => {
      const ro = mkdtempSync(path.join(os.tmpdir(), "pw-ro-"));
      chmodSync(ro, 0o500);
      vi.stubEnv("TMPDIR", ro);
      try {
        const containment = resolveAgentContainment(
          GOVERNED_PROFILE,
          undefined,
        );
        const out = await defaultClaudeCodeFn("x", { containment });
        expect(out).toMatch(/contained_settings_unwritable/);
        expect(existsSync(argvFile)).toBe(false);
      } finally {
        chmodSync(ro, 0o700);
        rmSync(ro, { recursive: true, force: true });
      }
    },
  );

  it("compat sandbox opt-in on the local path: legacy argv, unchanged", async () => {
    const containment = resolveAgentContainment(COMPAT_PROFILE, {
      sandbox: true,
      allowedTools: ["Read"],
    });
    await defaultClaudeCodeFn("x", {
      containment,
      sandbox: true,
      allowedTools: ["Read"],
    });
    const args = argv();
    expect(flagValues(args, "--permission-mode")).toEqual(["dontAsk"]);
    expect(flagValues(args, "--allowed-tools")).toEqual(["Read"]);
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--settings");
    expect(childEnv().LOCAL_TEST_UNRELATED_SECRET).toBe(
      "must-not-be-inherited",
    );
  });

  it("compat (no containment): argv is unchanged — no settings sources, no dontAsk", async () => {
    await defaultClaudeCodeFn("x");
    const args = argv();
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--tools");
    expect(childEnv().LOCAL_TEST_UNRELATED_SECRET).toBe(
      "must-not-be-inherited",
    );
  });
});

describe("local path MCP refusal", () => {
  it("a strict containment that grants bridge MCP is refused, not silently dropped", async () => {
    const containment = resolveAgentContainment(GOVERNED_PROFILE, {
      mcpAccess: true,
    });
    const out = await defaultClaudeCodeFn("x", { containment });
    expect(out).toMatch(/recipe_mcp_unsupported/);
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe("governed deny list covers the write-capable built-ins", () => {
  it("denied by default, so no settings-file allow rule can re-enable them", () => {
    const c = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    expect(c.deniedTools).toEqual(expect.arrayContaining(WRITE_TOOLS));
    for (const t of WRITE_TOOLS) expect(c.allowedTools).not.toContain(t);
  });

  it("the step's own tools: lifts exactly the named tool, as a recorded widening", () => {
    const w = resolveAgentContainment(GOVERNED_PROFILE, {
      allowedTools: ["Edit"],
    });
    expect(w.allowedTools).toContain("Edit");
    expect(w.deniedTools).not.toContain("Edit");
    expect(w.deniedTools).toEqual(
      expect.arrayContaining(["Write", "MultiEdit", "NotebookEdit"]),
    );
    expect(w.widenings).toContain("allowedTools+Edit");
  });

  it("a step that both allows and denies a write tool keeps it denied", () => {
    const w = resolveAgentContainment(GOVERNED_PROFILE, {
      allowedTools: ["Write"],
      disallowedTools: ["Write"],
    });
    expect(w.allowedTools).not.toContain("Write");
    expect(w.deniedTools).toContain("Write");
  });

  it("governed containment is marked strict; compat containment is not", () => {
    expect(resolveAgentContainment(GOVERNED_PROFILE, undefined).strict).toBe(
      true,
    );
    expect(
      resolveAgentContainment(COMPAT_PROFILE, { sandbox: true }).strict,
    ).toBeFalsy();
  });
});
