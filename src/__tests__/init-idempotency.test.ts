/**
 * Tests for init subcommand idempotency — versioned bridge block in CLAUDE.md.
 *
 * Covers:
 *   1. First-run write: no CLAUDE.md → returns "no-section"
 *   2. Same-version skip: versioned block with current version → "already-current"
 *   3. Stale-version update: versioned block with old version → "updated"
 *   4. Missing stamp update: unversioned marker + import → "patched" (wraps in versioned block)
 *   5. Unversioned marker, import missing → "patched"
 *   6. No marker, no import → "no-section"
 *   7. extractClaudeMdBlockVersion helpers
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractClaudeMdBlockVersion, patchClaudeMdImport } from "../index.js";

const MARKER = "## Claude IDE Bridge";
const IMPORT_LINE = "@import .claude/rules/bridge-tools.md";
const CURRENT_VERSION = "9.99.0"; // sentinel — never a real version
const OLD_VERSION = "1.0.0";

function makeVersionedBlock(version: string): string {
  return [
    `<!-- claude-ide-bridge:start:${version} -->`,
    MARKER,
    IMPORT_LINE,
    `<!-- claude-ide-bridge:end -->`,
  ].join("\n");
}

describe("extractClaudeMdBlockVersion", () => {
  it("returns null when no block present", () => {
    expect(
      extractClaudeMdBlockVersion("# Some file\nno bridge here"),
    ).toBeNull();
  });

  it("returns version string from start sentinel", () => {
    const content = `# Header\n\n${makeVersionedBlock("2.35.1")}\n`;
    expect(extractClaudeMdBlockVersion(content)).toBe("2.35.1");
  });

  it("returns null for malformed sentinel (missing end)", () => {
    const content = `<!-- claude-ide-bridge:start:2.0.0 -->\n${MARKER}\n`;
    expect(extractClaudeMdBlockVersion(content)).toBeNull();
  });
});

describe("patchClaudeMdImport", () => {
  let tmpDir: string;
  let claudeMd: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "init-idempotency-")),
    );
    claudeMd = path.join(tmpDir, "CLAUDE.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: file absent ────────────────────────────────────────────────────
  it("returns no-section when CLAUDE.md does not exist", () => {
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("no-section");
    expect(fs.existsSync(claudeMd)).toBe(false);
  });

  // ── Test 2: same-version skip ──────────────────────────────────────────────
  it("returns already-current when versioned block matches current version", () => {
    fs.writeFileSync(
      claudeMd,
      `# Project\n\n${makeVersionedBlock(CURRENT_VERSION)}\n`,
    );
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("already-current");
    // File must be unchanged
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(extractClaudeMdBlockVersion(content)).toBe(CURRENT_VERSION);
    // No .bak file should be created
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.endsWith(".bak"))).toBe(false);
  });

  // ── Test 3: stale-version update ──────────────────────────────────────────
  it("returns updated and replaces stale versioned block", () => {
    fs.writeFileSync(
      claudeMd,
      `# Project\n\n${makeVersionedBlock(OLD_VERSION)}\n`,
    );
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("updated");
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(extractClaudeMdBlockVersion(content)).toBe(CURRENT_VERSION);
    // Old version stamp must be gone
    expect(content).not.toContain(`start:${OLD_VERSION}`);
    // A backup file should exist
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.endsWith(".bak"))).toBe(true);
  });

  // ── Test 4: missing stamp — marker + import present, no sentinel ──────────
  it("returns patched and wraps existing unversioned block in sentinel", () => {
    fs.writeFileSync(claudeMd, `# Project\n\n${MARKER}\n\n${IMPORT_LINE}\n`);
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("patched");
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(extractClaudeMdBlockVersion(content)).toBe(CURRENT_VERSION);
    expect(content).toContain(MARKER);
    expect(content).toContain(IMPORT_LINE);
    expect(content).toContain("<!-- claude-ide-bridge:end -->");
  });

  // ── Test 5: marker present, import missing ─────────────────────────────────
  it("returns patched when marker exists but import line is absent", () => {
    fs.writeFileSync(claudeMd, `# Project\n\n${MARKER}\nSome text\n`);
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("patched");
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain(IMPORT_LINE);
    expect(extractClaudeMdBlockVersion(content)).toBe(CURRENT_VERSION);
  });

  // ── Test 6: no marker, import line orphan ─────────────────────────────────
  it("returns already-present when import line exists without marker", () => {
    fs.writeFileSync(claudeMd, `# Project\n\n${IMPORT_LINE}\n`);
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("already-present");
  });

  // ── Test 7: no marker, no import ──────────────────────────────────────────
  it("returns no-section when neither marker nor import is present", () => {
    fs.writeFileSync(claudeMd, "# My Project\n\nSome existing content.\n");
    const result = patchClaudeMdImport(
      claudeMd,
      MARKER,
      IMPORT_LINE,
      CURRENT_VERSION,
    );
    expect(result).toBe("no-section");
    // File should be unchanged
    expect(fs.readFileSync(claudeMd, "utf-8")).toBe(
      "# My Project\n\nSome existing content.\n",
    );
  });

  // ── Test 8: updated result preserves surrounding content ──────────────────
  it("preserves content before and after stale block when updating", () => {
    const before = "# Project\n\nSome intro text.\n\n";
    const after = "\n## Other section\n\nMore content.\n";
    fs.writeFileSync(
      claudeMd,
      `${before}${makeVersionedBlock(OLD_VERSION)}${after}`,
    );
    patchClaudeMdImport(claudeMd, MARKER, IMPORT_LINE, CURRENT_VERSION);
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("Some intro text.");
    expect(content).toContain("## Other section");
    expect(content).toContain("More content.");
    expect(extractClaudeMdBlockVersion(content)).toBe(CURRENT_VERSION);
  });
});
