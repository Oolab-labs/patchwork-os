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
    expect(fs.readFileSync(rulesFile, "utf-8")).toContain("runTests");
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
    expect(result.stderr).toContain("already contains");

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
    expect(result.stderr).toContain("already present");

    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content.split("## Claude IDE Bridge").length - 1).toBe(1);
  });
});
