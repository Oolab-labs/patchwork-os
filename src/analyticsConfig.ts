/**
 * On-disk config for the opt-in telemetry collector (endpoint + shared secret).
 *
 * Lives at ~/.claude/ide/analytics-config.json (respects CLAUDE_CONFIG_DIR).
 * Mode 0600. Atomic writes via temp + rename.
 *
 * Resolution order in analyticsSend.ts:
 *   1. process.env.PATCHWORK_ANALYTICS_ENDPOINT / _KEY  (highest)
 *   2. this file
 *   3. upstream default (no key)
 *
 * Reason for the file: keeps the shared secret out of launchd plists
 * (which are Time-Machine backed, iCloud synced, and survive reinstalls
 * in an inconsistent way) and gives operators a single source of truth
 * managed by the `patchwork analytics configure` CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AnalyticsConfig {
  endpoint?: string;
  key?: string;
}

export function configPath(): string {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(claudeDir, "ide", "analytics-config.json");
}

function isValidEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Read the config file. Returns empty object on missing/invalid file. */
export function getAnalyticsConfig(): AnalyticsConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null) return {};
    const rec = obj as Record<string, unknown>;
    const out: AnalyticsConfig = {};
    if (isValidEndpoint(rec.endpoint)) out.endpoint = rec.endpoint;
    if (typeof rec.key === "string" && rec.key.length > 0) out.key = rec.key;
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomic write with mode 0600. Merges with existing config — pass
 * `{ endpoint: undefined }` to clear a field explicitly.
 */
export function setAnalyticsConfig(update: AnalyticsConfig): void {
  const current = getAnalyticsConfig();
  const next: AnalyticsConfig = { ...current };
  if ("endpoint" in update) {
    if (update.endpoint === undefined) delete next.endpoint;
    else if (isValidEndpoint(update.endpoint)) next.endpoint = update.endpoint;
    else
      throw new Error(
        `invalid endpoint (must be http(s) URL): ${update.endpoint}`,
      );
  }
  if ("key" in update) {
    if (update.key === undefined) delete next.key;
    else next.key = update.key;
  }
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function clearAnalyticsConfig(): void {
  try {
    fs.unlinkSync(configPath());
  } catch {
    /* file may not exist */
  }
}
