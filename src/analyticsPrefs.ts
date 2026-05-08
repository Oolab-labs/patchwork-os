/**
 * Reads and writes the opt-in analytics preference.
 * Stored in ~/.claude/ide/analytics.json (respects CLAUDE_CONFIG_DIR).
 * File created with 0o600 permissions (owner read/write only).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface PrefsFile {
  enabled: boolean;
  decidedAt: string; // ISO8601
}

function prefsPath(): string {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(claudeDir, "ide", "analytics.json");
}

function saltPath(): string {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(claudeDir, "ide", "analytics-salt");
}

/** Returns the current opt-in state, or null if no preference has been set. */
export function getAnalyticsPref(): boolean | null {
  const p = prefsPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      "enabled" in obj &&
      typeof (obj as PrefsFile).enabled === "boolean"
    ) {
      return (obj as PrefsFile).enabled;
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

/** Persists the opt-in preference. Creates file with 0o600 permissions. */
export function setAnalyticsPref(enabled: boolean): void {
  const p = prefsPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const content: PrefsFile = {
    enabled,
    decidedAt: new Date().toISOString(),
  };
  // Write to temp file then rename for atomicity
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, p);
}

/**
 * Returns the per-install salt used to hash plugin tool names before they're
 * sent in the opt-in usage summary. Generated lazily on first call and stored
 * at ~/.claude/ide/analytics-salt (mode 0o600). Never transmitted.
 *
 * Why a salt: an unsalted SHA256 of "acme_deploy" produces the same 8-char
 * prefix on every install, which would let a receiver correlate plugin usage
 * across users. With a per-install salt, the same plugin hashes differently
 * on different machines.
 */
export function getAnalyticsSalt(): string {
  const p = saltPath();
  try {
    const raw = fs.readFileSync(p, "utf-8").trim();
    if (raw.length >= 16) return raw;
  } catch {
    // fall through to generate
  }
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const salt = crypto.randomBytes(16).toString("hex");
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${salt}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
  return salt;
}
