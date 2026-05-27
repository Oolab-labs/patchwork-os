/**
 * Integration test: `defaultClaudeCodeFn` threads the resolved workspace
 * root into `spawnSync` as `cwd`, instead of inheriting `$HOME` from the
 * bridge LaunchAgent.
 *
 * Unit tests for `resolveWorkspaceRoot` prove the helper logic; this test
 * proves the wiring — a real subprocess launched by `defaultClaudeCodeFn`
 * lands in the workspace dir, not in whatever cwd the test runner happens
 * to use. Uses a fake `claude` shell script (via `PATCHWORK_CLAUDE_BINARY`)
 * that prints its own `pwd`, so the assertion is end-to-end through the
 * real spawn — no mocks of `node:child_process`.
 *
 * Bug context: P2 of the 2026-05-20 improvement-research run — the bridge
 * LaunchAgent sets WorkingDirectory=$HOME, so agent steps shelling out to
 * git/npm/project scripts failed with "fatal: not a git repository"
 * (231/232 silent-fail halts).
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultClaudeCodeFn } from "../yamlRunner.js";

let workspace: string;
let fakeBinDir: string;
let savedBinary: string | undefined;
let savedWorkspace: string | undefined;

beforeEach(() => {
  // Real git repo so resolveWorkspaceRoot's git-ancestor walk could find
  // it if needed. Tests below set PATCHWORK_WORKSPACE explicitly so the
  // path through the resolver is deterministic regardless of where the
  // test runner is launched from.
  workspace = mkdtempSync(path.join(os.tmpdir(), "pw-cwd-ws-"));
  execSync("git init -q -b main", { cwd: workspace });

  // Fake `claude` binary: prints its cwd. Mirrors how a real run would
  // behave when `harvest_internal` shells out — but for the spawn path
  // itself, not the LLM behaviour.
  fakeBinDir = mkdtempSync(path.join(os.tmpdir(), "pw-cwd-bin-"));
  const fakeClaude = path.join(fakeBinDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\npwd\n");
  chmodSync(fakeClaude, 0o755);

  savedBinary = process.env.PATCHWORK_CLAUDE_BINARY;
  savedWorkspace = process.env.PATCHWORK_WORKSPACE;
  process.env.PATCHWORK_CLAUDE_BINARY = fakeClaude;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
  if (savedBinary === undefined) delete process.env.PATCHWORK_CLAUDE_BINARY;
  else process.env.PATCHWORK_CLAUDE_BINARY = savedBinary;
  if (savedWorkspace === undefined) delete process.env.PATCHWORK_WORKSPACE;
  else process.env.PATCHWORK_WORKSPACE = savedWorkspace;
});

describe("defaultClaudeCodeFn — workspace cwd threading", () => {
  // The fake `claude` is a `#!/bin/sh` script — POSIX-only. Windows
  // `spawnSync` can't execute it, so the spawn fails, `defaultClaudeCodeFn`
  // returns the `[agent step failed: claude CLI not found]` placeholder,
  // and `realpathSync` on that string throws an unrelated ENOENT. The
  // resolver logic itself is covered platform-agnostically by
  // `resolveWorkspaceRoot.test.ts`; skip this end-to-end spawn assertion
  // on Windows.
  it.skipIf(process.platform === "win32")(
    "spawns the agent subprocess with cwd = PATCHWORK_WORKSPACE",
    async () => {
      process.env.PATCHWORK_WORKSPACE = workspace;
      const out = await defaultClaudeCodeFn("ignored — fake binary");
      // `pwd` on macOS may resolve /var → /private/var; compare via realpath.
      expect(realpathSync(out)).toBe(realpathSync(workspace));
    },
  );

  it("returns the typed recipe_no_workspace error when no workspace resolves", async () => {
    // No env var, no .git ancestor of a deeply-nested tmpdir.
    const isolated = mkdtempSync(path.join(os.tmpdir(), "pw-cwd-isolated-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(isolated);
      const out = await defaultClaudeCodeFn("ignored");
      expect(out).toMatch(/^\[agent step failed: recipe_no_workspace\b/);
      // Must mention how to fix it — operators reading the halt log need
      // the env var name + the recipe field as actionable info.
      expect(out).toMatch(/PATCHWORK_WORKSPACE/);
      expect(out).toMatch(/workspace:/);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("returns typed recipe_mcp_unsupported when mcpAccess:true (was: silently ignored)", async () => {
    // Pre-fix: `_opts.mcpAccess` was underscore-prefixed and ignored. Recipes
    // declaring mcpAccess:true got a spawn with no MCP injection AND no
    // warning. Now defaultClaudeCodeFn surfaces a typed reason so the run
    // halts visibly and the operator routes via SubprocessDriver instead.
    process.env.PATCHWORK_WORKSPACE = workspace;
    const out = await defaultClaudeCodeFn("ignored", { mcpAccess: true });
    expect(out).toMatch(/^\[agent step failed: recipe_mcp_unsupported\b/);
    expect(out).toMatch(/SubprocessDriver/);
  });

  it.skipIf(process.platform === "win32")(
    "sanitizes CLAUDECODE / CLAUDE_CODE_* / MCP_* from child env (env-leak guard)",
    async () => {
      process.env.PATCHWORK_WORKSPACE = workspace;
      // Plant parent-session vars that would otherwise leak to the child.
      const savedCC = process.env.CLAUDECODE;
      const savedSession = process.env.CLAUDE_CODE_SESSION_ID;
      const savedMcp = process.env.MCP_SERVERS_JSON;
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_CODE_SESSION_ID = "parent-session-xyz";
      process.env.MCP_SERVERS_JSON = '{"bridge":"http://parent"}';

      // Swap the fake claude binary for one that dumps the relevant env vars
      // so the test can prove they're absent in the child.
      const dumpClaude = path.join(fakeBinDir, "claude");
      writeFileSync(
        dumpClaude,
        '#!/bin/sh\necho "CLAUDECODE=${CLAUDECODE:-unset}"\necho "CLAUDE_CODE_SESSION_ID=${CLAUDE_CODE_SESSION_ID:-unset}"\necho "MCP_SERVERS_JSON=${MCP_SERVERS_JSON:-unset}"\n',
      );
      chmodSync(dumpClaude, 0o755);

      try {
        const out = await defaultClaudeCodeFn("ignored");
        expect(out).toContain("CLAUDECODE=unset");
        expect(out).toContain("CLAUDE_CODE_SESSION_ID=unset");
        expect(out).toContain("MCP_SERVERS_JSON=unset");
      } finally {
        if (savedCC === undefined) delete process.env.CLAUDECODE;
        else process.env.CLAUDECODE = savedCC;
        if (savedSession === undefined)
          delete process.env.CLAUDE_CODE_SESSION_ID;
        else process.env.CLAUDE_CODE_SESSION_ID = savedSession;
        if (savedMcp === undefined) delete process.env.MCP_SERVERS_JSON;
        else process.env.MCP_SERVERS_JSON = savedMcp;
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves CLAUDE_CODE_OAUTH_TOKEN (subscription auth must survive sanitize)",
    async () => {
      process.env.PATCHWORK_WORKSPACE = workspace;
      const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test-survives";

      const dumpClaude = path.join(fakeBinDir, "claude");
      writeFileSync(
        dumpClaude,
        '#!/bin/sh\necho "OAUTH=${CLAUDE_CODE_OAUTH_TOKEN:-unset}"\n',
      );
      chmodSync(dumpClaude, 0o755);

      try {
        const out = await defaultClaudeCodeFn("ignored");
        expect(out).toContain("OAUTH=sk-ant-oat01-test-survives");
      } finally {
        if (savedOauth === undefined)
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "passes --strict-mcp-config to claude -p (no ~/.claude.json MCP attach)",
    async () => {
      process.env.PATCHWORK_WORKSPACE = workspace;
      // Replace claude with a script that echoes its argv.
      const echoClaude = path.join(fakeBinDir, "claude");
      writeFileSync(echoClaude, '#!/bin/sh\necho "$@"\n');
      chmodSync(echoClaude, 0o755);

      const out = await defaultClaudeCodeFn("ignored");
      expect(out).toContain("--strict-mcp-config");
    },
  );
});
