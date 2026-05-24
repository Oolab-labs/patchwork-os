/**
 * Reads and writes the opt-in telemetry preferences.
 * Stored in ~/.claude/ide/analytics.json (respects CLAUDE_CONFIG_DIR).
 * File created with 0o600 permissions (owner read/write only).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Atomic rename helper: on Windows `renameSync` throws EEXIST when the target
 * already exists (unlike POSIX which replaces atomically). Unlink + retry once.
 */
function atomicRename(tmp: string, target: string): void {
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    if (
      process.platform === "win32" &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      fs.unlinkSync(target);
      fs.renameSync(tmp, target);
    } else {
      throw err;
    }
  }
}

export interface TelemetryPrefs {
  crashReports: boolean;
  usageStats: boolean;
  localDiagnostics: boolean;
}

interface PrefsFileV2 {
  crashReports: boolean;
  usageStats: boolean;
  localDiagnostics: boolean;
  decidedAt: string; // ISO8601
  lastSentAt?: string; // ISO8601 — updated after each successful analytics send
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

/** Public paths for the /telemetry-prefs DELETE handler. */
export function getAnalyticsPrefsPath(): string {
  return prefsPath();
}
export function getAnalyticsSaltPath(): string {
  return saltPath();
}

/**
 * Read and migrate the on-disk prefs to the v2 shape.
 * Old files with only `enabled` map to:
 *   { crashReports: enabled, usageStats: enabled, localDiagnostics: false }
 */
export function getTelemetryPrefs(): TelemetryPrefs {
  const p = prefsPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null) {
      return {
        crashReports: false,
        usageStats: false,
        localDiagnostics: false,
      };
    }
    const rec = obj as Record<string, unknown>;

    // v2 shape
    if (typeof rec.crashReports === "boolean") {
      return {
        crashReports: rec.crashReports,
        usageStats:
          typeof rec.usageStats === "boolean" ? rec.usageStats : false,
        localDiagnostics:
          typeof rec.localDiagnostics === "boolean"
            ? rec.localDiagnostics
            : false,
      };
    }

    // v1 migration — `enabled` only
    if (typeof rec.enabled === "boolean") {
      return {
        crashReports: rec.enabled,
        usageStats: rec.enabled,
        localDiagnostics: false,
      };
    }

    return { crashReports: false, usageStats: false, localDiagnostics: false };
  } catch (_err) {
    return { crashReports: false, usageStats: false, localDiagnostics: false };
  }
}

/** Partial-merge update. Reads current prefs, applies supplied fields, writes back. */
export function setTelemetryPrefs(prefs: Partial<TelemetryPrefs>): void {
  const current = getTelemetryPrefs();
  const next: PrefsFileV2 = {
    crashReports:
      prefs.crashReports !== undefined
        ? prefs.crashReports
        : current.crashReports,
    usageStats:
      prefs.usageStats !== undefined ? prefs.usageStats : current.usageStats,
    localDiagnostics:
      prefs.localDiagnostics !== undefined
        ? prefs.localDiagnostics
        : current.localDiagnostics,
    decidedAt: new Date().toISOString(),
  };
  writePrefs(next);
}

function writePrefs(content: PrefsFileV2): void {
  const p = prefsPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, {
    mode: 0o600,
  });
  atomicRename(tmp, p);
}

/**
 * Returns the raw prefs file contents including optional `lastSentAt` timestamp.
 * Returns null when no prefs file exists yet.
 */
export function getAnalyticsPrefsAll():
  | (PrefsFileV2 & { lastSentAt?: string })
  | null {
  const p = prefsPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj === "object" && obj !== null) {
      return obj as PrefsFileV2 & { lastSentAt?: string };
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

/**
 * Records the current time as `lastSentAt` in the prefs file.
 * No-op if no prefs file exists yet (user never opted in, nothing to record).
 */
export function recordAnalyticsSent(): void {
  const p = prefsPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj === "object" && obj !== null) {
      const updated = {
        ...(obj as PrefsFileV2),
        lastSentAt: new Date().toISOString(),
      };
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, {
        mode: 0o600,
      });
      atomicRename(tmp, p);
    }
  } catch {
    // No prefs file or unreadable — nothing to update
  }
}

// ---------------------------------------------------------------------------
// Legacy API — kept for callers that predate the three-flag shape.
// Derived from usageStats so existing analytics collection doesn't change.
// ---------------------------------------------------------------------------

/** Returns the current opt-in state, or null if no preference has been set. */
export function getAnalyticsPref(): boolean | null {
  const p = prefsPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    JSON.parse(raw);
  } catch {
    return null;
  }
  const prefs = getTelemetryPrefs();
  return prefs.usageStats;
}

/** Persists the opt-in preference (legacy single-boolean form). */
export function setAnalyticsPref(enabled: boolean): void {
  setTelemetryPrefs({ usageStats: enabled, crashReports: enabled });
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
  atomicRename(tmp, p);
  return salt;
}
