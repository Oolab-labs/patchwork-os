/**
 * Reads and writes the opt-in analytics preference.
 * Stored in ~/.claude/ide/analytics.json (respects CLAUDE_CONFIG_DIR).
 * File created with 0o600 permissions (owner read/write only).
 */

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
