/**
 * Subprocess-driver env-allowlist parity — Issue #850 (driver-parity axis).
 *
 * The driver fork is half the recurring defect class: an env var that leaks the
 * parent Claude Code session's credentials into a spawned agent has been fixed
 * one-driver-at-a-time more than once (PR #777 Claude OAuth strip later lost in
 * a squash; H5 audit 2026-06-19 added the Gemini foreign-cred strip). The
 * invariant we pin here: EVERY subprocess driver routes its child env through
 * the single shared `sanitizeEnv` allowlist — none hand-rolls its own — and the
 * shared allowlist strips the parent's Anthropic API key. API-only drivers
 * (OpenAI / Grok / local) spawn no CLI subprocess and so carry no env-leak
 * surface.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "../claude/envSanitizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const driversRoot = path.resolve(__dirname, "..");

// ── shared allowlist invariants ─────────────────────────────────────────────
describe("sanitizeEnv — shared subprocess env allowlist", () => {
  it("strips the parent's Anthropic API key (the core leak vector)", () => {
    const out = sanitizeEnv({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      PATH: "/bin",
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/bin"); // unrelated vars survive
  });

  it("strips CLAUDECODE, CLAUDE_CODE_* and MCP_* session vars", () => {
    const out = sanitizeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "1234",
      MCP_SERVER_NAME: "patchwork",
      KEEP_ME: "yes",
    });
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(out.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(out.MCP_SERVER_NAME).toBeUndefined();
    expect(out.KEEP_ME).toBe("yes");
  });

  it("PRESERVES CLAUDE_CODE_OAUTH_TOKEN (subscription auth the child needs)", () => {
    const out = sanitizeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("does not mutate the input env object", () => {
    const input = { ANTHROPIC_API_KEY: "sk", PATH: "/bin" };
    sanitizeEnv(input);
    expect(input.ANTHROPIC_API_KEY).toBe("sk");
  });
});

// ── structural symmetry: every subprocess driver uses the shared seam ────────
//
// A source-level check is the right tool here: the defect class is a driver
// that builds its child env WITHOUT routing through sanitizeEnv. Asserting each
// subprocess driver imports + calls the shared helper catches that at the seam,
// not after a leak ships.
describe("driver env parity — subprocess drivers route through sanitizeEnv", () => {
  const SUBPROCESS_DRIVERS = [
    { name: "claude", file: "claude/subprocess.ts" },
    { name: "gemini", file: "gemini/index.ts" },
  ];

  for (const d of SUBPROCESS_DRIVERS) {
    it(`${d.name} driver builds its child env via sanitizeEnv`, () => {
      const src = readFileSync(path.join(driversRoot, d.file), "utf8");
      expect(src).toMatch(/sanitizeEnv\s*\(\s*process\.env\s*\)/);
    });
  }

  // OpenAI / Grok / local are HTTP API drivers: they must not spawn a CLI
  // subprocess (no child env, no leak surface). If one ever grows a spawn, it
  // must adopt sanitizeEnv too — this guard forces that conversation.
  const API_DRIVERS = [
    { name: "openai", file: "openai/index.ts" },
    { name: "local", file: "local/index.ts" },
  ];

  for (const d of API_DRIVERS) {
    it(`${d.name} driver spawns no CLI subprocess`, () => {
      const src = readFileSync(path.join(driversRoot, d.file), "utf8");
      expect(src).not.toMatch(/from\s+["']node:child_process["']/);
      expect(src).not.toMatch(/\bspawn\s*\(/);
    });
  }
});
