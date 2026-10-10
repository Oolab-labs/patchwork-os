/**
 * Phase 0 acceptance — scenario 9: containment on the local run path, and
 * workspace settings that must not reach a contained agent.
 *
 * 1. `recipe run --local` and `recipe record` spawn the Claude CLI through
 *    `defaultClaudeCodeFn`, not the subprocess driver. Under the governed
 *    profile the runner hands it a resolved containment; it must apply it
 *    exactly as the driver does.
 * 2. A contained run must load only the operator's USER settings. Project and
 *    local settings live in the workspace, so a repository can ship them:
 *    their hooks run shell commands (observed against the real CLI: a
 *    project PreToolUse hook ran inside a contained `-p` run), and an allow
 *    rule from any loaded source re-enables a tool that is merely absent from
 *    `--allowed-tools`. So contained runs pass `--setting-sources user`, and
 *    the write-capable built-ins are DENIED (a deny beats any allow), not
 *    just left off the allowlist.
 *
 * Driven through the real `defaultClaudeCodeFn` (and the real runner) with a
 * fake `claude` script that records its argv and env — no mocks of
 * `node:child_process`. POSIX only: the fake binary is a shell script.
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import {
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
const sandbox = makeSandbox("local-containment");
afterAll(() => sandbox.dispose());

let workspace: string;
let binDir: string;
let argvFile: string;
let envFile: string;

beforeEach(() => {
  resetGovernanceState();
  workspace = mkdtempSync(path.join(os.tmpdir(), "pw-local-ws-"));
  execSync("git init -q -b main", { cwd: workspace });
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

function expectContainedLocal(args: string[]) {
  expect(flagValues(args, "--permission-mode")).toEqual(["dontAsk"]);
  expect(flagValues(args, "--setting-sources")).toEqual(["user"]);
  const denied = flagValues(args, "--disallowed-tools");
  expect(denied).toEqual(
    expect.arrayContaining(["WebFetch", "WebSearch", "Bash", ...WRITE_TOOLS]),
  );
  for (const t of flagValues(args, "--allowed-tools")) {
    expect(CONTAINED_AGENT_ALLOWED_TOOLS).toContain(t);
  }
  // The deny list is also written into the settings file the run loads.
  const settingsPath = flagValues(args, "--settings")[0];
  expect(settingsPath).toBeTruthy();
  const settings = JSON.parse(readFileSync(settingsPath as string, "utf8")) as {
    permissions?: { deny?: string[] };
  };
  expect(settings.permissions?.deny).toEqual(
    expect.arrayContaining(["Bash", "WebFetch", ...WRITE_TOOLS]),
  );
  const env = childEnv();
  expect(env.PATH).toBeTruthy();
  expect(env.LOCAL_TEST_UNRELATED_SECRET).toBeUndefined();
}

describe.skipIf(process.platform === "win32")(
  "local run path applies governed containment",
  () => {
    it("defaultClaudeCodeFn with a resolved containment → contained argv, settings and env", async () => {
      const containment = resolveAgentContainment(GOVERNED_PROFILE, undefined);
      const out = await defaultClaudeCodeFn("summarise", { containment });
      expect(out).toBe("fake-reply");
      expectContainedLocal(argv());
    });

    it("through the real runner: a governed agent step on the local CLI path is contained", async () => {
      const profile = governed();
      const recipe: YamlRecipe = {
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
      expectContainedLocal(argv());
    });

    it("a containment that grants bridge MCP is refused, not silently dropped", async () => {
      const containment = resolveAgentContainment(GOVERNED_PROFILE, {
        mcpAccess: true,
      });
      const out = await defaultClaudeCodeFn("x", { containment });
      expect(out).toMatch(/recipe_mcp_unsupported/);
      expect(existsSync(argvFile)).toBe(false);
    });

    it("compat (no containment): argv is unchanged — no settings sources, no dontAsk", async () => {
      await defaultClaudeCodeFn("x");
      const args = argv();
      expect(args).not.toContain("--setting-sources");
      expect(args).not.toContain("--permission-mode");
      expect(args).not.toContain("--settings");
      expect(childEnv().LOCAL_TEST_UNRELATED_SECRET).toBe(
        "must-not-be-inherited",
      );
    });
  },
);

describe("governed deny list covers the write-capable built-ins", () => {
  it("denied by default, so no settings-file allow rule can re-enable them", () => {
    const c = resolveAgentContainment(GOVERNED_PROFILE, undefined);
    expect(c.deniedTools).toEqual(expect.arrayContaining(WRITE_TOOLS));
    for (const t of WRITE_TOOLS) expect(c.allowedTools).not.toContain(t);
  });

  it("the recipe's own allowedTools lifts exactly the named tool, as a recorded widening", () => {
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

  it("a recipe that both allows and denies a write tool keeps it denied", () => {
    const w = resolveAgentContainment(GOVERNED_PROFILE, {
      allowedTools: ["Write"],
      disallowedTools: ["Write"],
    });
    expect(w.allowedTools).not.toContain("Write");
    expect(w.deniedTools).toContain("Write");
  });
});
