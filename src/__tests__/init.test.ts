/**
 * Integration tests for `claude-ide-bridge init` and `gen-claude-md` CLI subcommands.
 *
 * These tests spawn the compiled dist/index.js to verify that the file-writing
 * behaviour works end-to-end, including the ENOENT fix (workspace dir created
 * before the tmp write) and the bridge-tools rules file placement.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../version.js";

const distIndex = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../dist/index.js",
);

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-init-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

beforeAll(() => {
  // Ensure dist is built before running these tests.
  if (!fs.existsSync(distIndex)) {
    throw new Error(`dist/index.js not found — run npm run build first`);
  }
});

// ---------------------------------------------------------------------------
// gen-claude-md --write
// ---------------------------------------------------------------------------

describe("gen-claude-md --write", () => {
  it("writes CLAUDE.md and bridge-tools.md to an existing workspace", () => {
    const ws = makeTmpDir();

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);

    const claudeMd = path.join(ws, "CLAUDE.md");
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, "utf-8")).toContain(
      "## Claude IDE Bridge",
    );
    expect(fs.readFileSync(claudeMd, "utf-8")).toContain(
      "@import .claude/rules/bridge-tools.md",
    );

    const rulesFile = path.join(ws, ".claude", "rules", "bridge-tools.md");
    expect(fs.existsSync(rulesFile)).toBe(true);
    expect(fs.readFileSync(rulesFile, "utf-8")).toContain("getDiagnostics");
  });

  it("is idempotent — running twice does not duplicate content", () => {
    const ws = makeTmpDir();
    const args = [
      "node",
      distIndex,
      "gen-claude-md",
      "--write",
      "--workspace",
      ws,
    ];
    const env = { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" };

    spawnSync(args[0]!, args.slice(1), { encoding: "utf-8", env });
    const result = spawnSync(args[0]!, args.slice(1), {
      encoding: "utf-8",
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /already up to date|already contains|no changes made/,
    );

    const claudeMd = path.join(ws, "CLAUDE.md");
    const content = fs.readFileSync(claudeMd, "utf-8");
    // Should appear exactly once
    expect(content.split("## Claude IDE Bridge").length - 1).toBe(1);
  });

  it("creates workspace directory if it does not exist (ENOENT fix)", () => {
    const base = makeTmpDir();
    const ws = path.join(base, "new-project"); // does not exist yet

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(ws, "CLAUDE.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(ws, ".claude", "rules", "bridge-tools.md")),
    ).toBe(true);
  });

  it("dry-run (no --write) prints CLAUDE.md content and a note about --write", () => {
    const result = spawnSync("node", [distIndex, "gen-claude-md"], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## Claude IDE Bridge");
    expect(result.stderr).toContain("--write");
    expect(result.stderr).toContain("bridge-tools.md");
  });
});

// ---------------------------------------------------------------------------
// init (file-write steps only — extension install is skipped in CI)
// ---------------------------------------------------------------------------

describe("init --workspace", () => {
  it("writes CLAUDE.md and bridge-tools.md to a non-existent workspace directory", () => {
    const base = makeTmpDir();
    const ws = path.join(base, "fresh-project");

    // Pipe "n" to skip the analytics prompt; extension install will warn but not fail.
    const result = spawnSync("node", [distIndex, "init", "--workspace", ws], {
      input: "n\n",
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      timeout: 30_000,
    });

    // Exit 0 even if extension install warns
    expect(result.status).toBe(0);

    const claudeMd = path.join(ws, "CLAUDE.md");
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, "utf-8")).toContain(
      "@import .claude/rules/bridge-tools.md",
    );

    const rulesFile = path.join(ws, ".claude", "rules", "bridge-tools.md");
    expect(fs.existsSync(rulesFile)).toBe(true);
    expect(fs.readFileSync(rulesFile, "utf-8")).toContain("MANDATORY");
  });

  it("is idempotent — bridge section and rules file are not duplicated on re-run", () => {
    const ws = makeTmpDir();
    const opts = {
      input: "n\n",
      encoding: "utf-8" as const,
      env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      timeout: 30_000,
    };

    spawnSync("node", [distIndex, "init", "--workspace", ws], opts);
    const result = spawnSync(
      "node",
      [distIndex, "init", "--workspace", ws],
      opts,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /bridge block already up to date|bridge section already present/,
    );

    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content.split("## Claude IDE Bridge").length - 1).toBe(1);
  });

  it("registers MCP shim at <CONFIG_DIR>.json, not at the path-lost sibling (regression)", () => {
    // Regression: prior code used `path.join(CONFIG_DIR, "..", "claude.json")`
    // which produces `~/claude.json` (no dot) instead of `~/.claude.json`.
    // Bug symptom: `init` reported success but Claude Code never saw the shim.
    const ws = makeTmpDir();
    const fakeHome = makeTmpDir();
    const configDir = path.join(fakeHome, ".claude");
    // No file or dir at configDir yet — init creates settings.json under it.
    const expectedClaudeJson = `${configDir}.json`; // ~/.claude.json equivalent
    const wrongClaudeJson = path.join(fakeHome, "claude.json"); // ghost file

    const result = spawnSync("node", [distIndex, "init", "--workspace", ws], {
      input: "n\n",
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true",
        CLAUDE_CONFIG_DIR: configDir,
        HOME: fakeHome,
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(expectedClaudeJson)).toBe(true);
    expect(fs.existsSync(wrongClaudeJson)).toBe(false);

    const parsed = JSON.parse(fs.readFileSync(expectedClaudeJson, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers?.["claude-ide-bridge"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 2: @import patch for existing CLAUDE.md without @import line
// ---------------------------------------------------------------------------

describe("gen-claude-md --write @import patch", () => {
  it("inserts @import line into existing CLAUDE.md that has the bridge section but no @import", () => {
    const ws = makeTmpDir();
    const claudeMd = path.join(ws, "CLAUDE.md");

    // Write a CLAUDE.md that has the marker but no @import line
    fs.writeFileSync(
      claudeMd,
      "# My Project\n\n## Claude IDE Bridge\n\nSome old content without @import.\n",
    );

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Patched");

    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("@import .claude/rules/bridge-tools.md");
    // Must not duplicate the section
    expect(content.split("## Claude IDE Bridge").length - 1).toBe(1);
    // Original content preserved
    expect(content).toContain("Some old content without @import.");
  });

  it("preserves user content under the bridge marker when @import is missing (Bug 2)", () => {
    const ws = makeTmpDir();
    const claudeMd = path.join(ws, "CLAUDE.md");

    // Marker present, user content between marker and next section, no @import
    fs.writeFileSync(
      claudeMd,
      "# My Project\n\n## Claude IDE Bridge\nMy custom note here.\n\n## Another Section\ncontent\n",
    );

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    const content = fs.readFileSync(claudeMd, "utf-8");
    // @import inserted
    expect(content).toContain("@import .claude/rules/bridge-tools.md");
    // User content NOT dropped
    expect(content).toContain("My custom note here.");
    // Other section still present
    expect(content).toContain("## Another Section");
    // Marker appears only once
    expect(content.split("## Claude IDE Bridge").length - 1).toBe(1);
  });

  it("does not modify CLAUDE.md when @import is already present", () => {
    const ws = makeTmpDir();
    const claudeMd = path.join(ws, "CLAUDE.md");
    const original =
      "# My Project\n\n## Claude IDE Bridge\n\n@import .claude/rules/bridge-tools.md\n\nContent here.\n";
    fs.writeFileSync(claudeMd, original);

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    // Either "no changes made" (old unversioned path) or "already up to date" (versioned block) or "patched" (wrapping)
    expect(result.stderr).toMatch(/no changes made|already up to date|Patched/);
    // Core content must be preserved
    const updatedContent = fs.readFileSync(claudeMd, "utf-8");
    expect(updatedContent).toContain("## Claude IDE Bridge");
    expect(updatedContent).toContain("@import .claude/rules/bridge-tools.md");
    expect(updatedContent).toContain("Content here.");
  });
});

describe("init --workspace @import patch", () => {
  it("patches existing CLAUDE.md with bridge section but no @import", () => {
    const ws = makeTmpDir();
    const claudeMd = path.join(ws, "CLAUDE.md");

    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(
      claudeMd,
      "# My Project\n\n## Claude IDE Bridge\n\nOld content.\n",
    );

    const result = spawnSync("node", [distIndex, "init", "--workspace", ws], {
      input: "n\n",
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/patched|Patched/);
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("@import .claude/rules/bridge-tools.md");
    expect(content.split("## Claude IDE Bridge").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Corrupted bridge-tools.md is repaired
// ---------------------------------------------------------------------------

describe("bridge-tools.md repair", () => {
  it("replaces a zero-byte bridge-tools.md on gen-claude-md --write", () => {
    const ws = makeTmpDir();
    const rulesDir = path.join(ws, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "bridge-tools.md"), ""); // zero bytes

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    const repaired = fs.readFileSync(
      path.join(rulesDir, "bridge-tools.md"),
      "utf-8",
    );
    expect(repaired).toContain("getDiagnostics");
  });

  it("replaces a corrupted bridge-tools.md on gen-claude-md --write", () => {
    const ws = makeTmpDir();
    const rulesDir = path.join(ws, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "bridge-tools.md"), "# corrupted");

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    const repaired = fs.readFileSync(
      path.join(rulesDir, "bridge-tools.md"),
      "utf-8",
    );
    expect(repaired).toContain("getDiagnostics");
  });

  it("does not overwrite a valid bridge-tools.md", () => {
    const ws = makeTmpDir();
    const rulesDir = path.join(ws, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    // Must satisfy the strengthened check: >200 bytes, contains getDiagnostics,
    // and MANDATORY (the section heading in the real template).
    const validContent = [
      `<!-- bridge-tools v${PACKAGE_VERSION} -->`,
      "",
      "# Bridge Tools — MANDATORY substitution table",
      "",
      "When the bridge is connected, ALWAYS use MCP tools instead of shell commands.",
      "",
      "| Shell command | MCP tool to use instead |",
      "|---|---|",
      "| tsc / eslint | getDiagnostics |",
      "| git commit | gitCommit |",
      "| grep / rg | searchWorkspace |",
      "| Calling getHover in a loop | batchGetHover |",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(rulesDir, "bridge-tools.md"), validContent);

    spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    // Content should be unchanged (valid file kept as-is)
    expect(
      fs.readFileSync(path.join(rulesDir, "bridge-tools.md"), "utf-8"),
    ).toBe(validContent);
  });

  it("replaces a stale bridge-tools.md that passes old 3-keyword check but lacks batchGetHover", () => {
    const ws = makeTmpDir();
    const rulesDir = path.join(ws, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    // Passes old validity (runTests + getDiagnostics + MANDATORY + >200 bytes)
    // but missing batchGetHover — should be replaced
    const staleContent = [
      "## Bridge Tool Overrides — MANDATORY",
      "| npm test | runTests |",
      "| tsc | getDiagnostics |",
      "x".repeat(300),
    ].join("\n");
    fs.writeFileSync(path.join(rulesDir, "bridge-tools.md"), staleContent);

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    const repaired = fs.readFileSync(
      path.join(rulesDir, "bridge-tools.md"),
      "utf-8",
    );
    expect(repaired).toContain("batchGetHover");
  });

  it("repairs stale bridge-tools.md even when CLAUDE.md already has @import (early-exit path)", () => {
    const ws = makeTmpDir();
    const rulesDir = path.join(ws, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    // Pre-seed CLAUDE.md with the @import + bridge section so patchClaudeMdImport
    // returns "already-present" and the command would normally exit early
    const claudeMdPath = path.join(ws, "CLAUDE.md");
    fs.writeFileSync(
      claudeMdPath,
      "## Claude IDE Bridge\n\n@import .claude/rules/bridge-tools.md\n",
    );
    // Pre-seed stale rules file (passes old 3-keyword check, missing batchGetHover)
    const staleContent = [
      "## Bridge Tool Overrides — MANDATORY",
      "| npm test | runTests |",
      "| tsc | getDiagnostics |",
      "x".repeat(300),
    ].join("\n");
    fs.writeFileSync(path.join(rulesDir, "bridge-tools.md"), staleContent);

    const result = spawnSync(
      "node",
      [distIndex, "gen-claude-md", "--write", "--workspace", ws],
      {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CODE_IDE_SKIP_VALID_CHECK: "true" },
      },
    );

    expect(result.status).toBe(0);
    // Rules file must be repaired despite the early exit
    const repaired = fs.readFileSync(
      path.join(rulesDir, "bridge-tools.md"),
      "utf-8",
    );
    expect(repaired).toContain("batchGetHover");
    // CLAUDE.md must be untouched
    expect(fs.readFileSync(claudeMdPath, "utf-8")).toContain(
      "## Claude IDE Bridge",
    );
  });
});
