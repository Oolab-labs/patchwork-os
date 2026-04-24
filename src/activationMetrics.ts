/**
 * Activation metrics — a small, local-only counter file that tracks how far
 * along the user is in the "first success" journey. Nothing here is ever
 * transmitted off-machine. The outbound usage analytics pipeline lives in
 * `analyticsAggregator.ts` / `analyticsSend.ts` and is a separate concern.
 *
 * Intended counters:
 *   - installedAt            first time any metric was recorded
 *   - firstRecipeRunAt       timestamp of the first successful recipe run
 *   - recipeRunsTotal        running count of successful recipe runs
 *   - recipeRunsByDay        map of YYYY-MM-DD -> count, trimmed to 14 days
 *   - approvalsPrompted      count of approval requests created
 *   - approvalsCompleted     count of approvals approved or rejected (not timed out)
 *
 * These feed a single "first success in N days" KPI card on the dashboard.
 *
 * Opt-out: if the existing outbound analytics preference is explicitly `false`
 * via `getAnalyticsPref()`, all record operations become no-ops. The user does
 * not need to re-opt-out; the existing opt-out is sufficient. Reads are
 * always allowed (they never leave the machine).
 *
 * Storage: `~/.patchwork/telemetry.json` (respects PATCHWORK_HOME override).
 * File is written atomically via tmp+rename with 0o600 permissions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAnalyticsPref } from "./analyticsPrefs.js";

export interface ActivationMetrics {
  installedAt: number;
  firstRecipeRunAt: number | null;
  recipeRunsTotal: number;
  recipeRunsByDay: Record<string, number>;
  approvalsPrompted: number;
  approvalsCompleted: number;
}

export interface ActivationSummary {
  installedAt: number;
  firstRecipeRunAt: number | null;
  /** Milliseconds between install and first successful recipe run. Null until first success. */
  timeToFirstRecipeRunMs: number | null;
  /** Total successful recipe runs across all time. */
  recipeRunsTotal: number;
  /** Recipe runs in the last 7 days (inclusive of today). */
  recipeRunsLast7Days: number;
  /** Distinct calendar days with at least one recipe run in the last 7 days. */
  activeDaysLast7: number;
  /** Fraction of prompted approvals that were completed (approved or rejected). 0..1 or null. */
  approvalCompletionRate: number | null;
  approvalsPrompted: number;
  approvalsCompleted: number;
}

const METRICS_FILENAME = "telemetry.json";
const MAX_DAYS_RETAINED = 14;

function resolveMetricsPath(configDir?: string): string {
  if (configDir) return path.join(configDir, METRICS_FILENAME);
  const root =
    process.env.PATCHWORK_HOME ?? path.join(os.homedir(), ".patchwork");
  return path.join(root, METRICS_FILENAME);
}

function emptyMetrics(now: number): ActivationMetrics {
  return {
    installedAt: now,
    firstRecipeRunAt: null,
    recipeRunsTotal: 0,
    recipeRunsByDay: {},
    approvalsPrompted: 0,
    approvalsCompleted: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceMetrics(raw: unknown, now: number): ActivationMetrics {
  if (!isRecord(raw)) return emptyMetrics(now);

  const installedAt =
    typeof raw.installedAt === "number" && raw.installedAt > 0
      ? raw.installedAt
      : now;
  const firstRecipeRunAt =
    typeof raw.firstRecipeRunAt === "number" && raw.firstRecipeRunAt > 0
      ? raw.firstRecipeRunAt
      : null;
  const recipeRunsTotal =
    typeof raw.recipeRunsTotal === "number" &&
    Number.isFinite(raw.recipeRunsTotal) &&
    raw.recipeRunsTotal >= 0
      ? Math.floor(raw.recipeRunsTotal)
      : 0;
  const byDay: Record<string, number> = {};
  if (isRecord(raw.recipeRunsByDay)) {
    for (const [k, v] of Object.entries(raw.recipeRunsByDay)) {
      if (
        typeof k === "string" &&
        isValidDayKey(k) &&
        typeof v === "number" &&
        Number.isFinite(v) &&
        v >= 0
      ) {
        byDay[k] = Math.floor(v);
      }
    }
  }
  const approvalsPrompted =
    typeof raw.approvalsPrompted === "number" &&
    Number.isFinite(raw.approvalsPrompted) &&
    raw.approvalsPrompted >= 0
      ? Math.floor(raw.approvalsPrompted)
      : 0;
  const approvalsCompleted =
    typeof raw.approvalsCompleted === "number" &&
    Number.isFinite(raw.approvalsCompleted) &&
    raw.approvalsCompleted >= 0
      ? Math.floor(raw.approvalsCompleted)
      : 0;

  return {
    installedAt,
    firstRecipeRunAt,
    recipeRunsTotal,
    recipeRunsByDay: byDay,
    approvalsPrompted,
    approvalsCompleted,
  };
}

/**
 * Load metrics from disk. Returns a fresh empty record if the file is missing
 * or malformed. Never throws on I/O errors.
 */
export function loadMetrics(
  configDir?: string,
  now: number = Date.now(),
): ActivationMetrics {
  const file = resolveMetricsPath(configDir);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return coerceMetrics(JSON.parse(raw) as unknown, now);
  } catch {
    return emptyMetrics(now);
  }
}

function isValidDayKey(key: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Round-trip check rejects impossible calendar dates (e.g. Feb 30).
  const reconstructed = new Date(Date.UTC(year, month - 1, day));
  return (
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() === month - 1 &&
    reconstructed.getUTCDate() === day
  );
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function trimByDay(
  byDay: Record<string, number>,
  retainDays: number,
): Record<string, number> {
  const keys = Object.keys(byDay).sort();
  if (keys.length <= retainDays) return byDay;
  const kept = keys.slice(keys.length - retainDays);
  const result: Record<string, number> = {};
  for (const k of kept) {
    const v = byDay[k];
    if (v !== undefined) result[k] = v;
  }
  return result;
}

function writeAtomic(file: string, metrics: ActivationMetrics): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(metrics, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

/** Returns true if the outbound analytics preference is not an explicit false. */
function isRecordingAllowed(): boolean {
  return getAnalyticsPref() !== false;
}

/**
 * Record one successful recipe run. Sets `firstRecipeRunAt` on the first call
 * and increments total + per-day counters. Trims the per-day map so the file
 * stays O(14 entries).
 *
 * No-op if the user has explicitly opted out of analytics.
 */
export function recordRecipeRun(
  configDir?: string,
  now: number = Date.now(),
): void {
  if (!isRecordingAllowed()) return;
  const file = resolveMetricsPath(configDir);
  const current = loadMetrics(configDir, now);
  const key = dayKey(now);
  const nextByDay = { ...current.recipeRunsByDay };
  nextByDay[key] = (nextByDay[key] ?? 0) + 1;

  const next: ActivationMetrics = {
    ...current,
    firstRecipeRunAt: current.firstRecipeRunAt ?? now,
    recipeRunsTotal: current.recipeRunsTotal + 1,
    recipeRunsByDay: trimByDay(nextByDay, MAX_DAYS_RETAINED),
  };
  try {
    writeAtomic(file, next);
  } catch {
    // Metrics must never affect product behavior — swallow write failures.
  }
}

/** Record an approval prompt being surfaced to the user. */
export function recordApprovalPrompted(
  configDir?: string,
  now: number = Date.now(),
): void {
  if (!isRecordingAllowed()) return;
  const file = resolveMetricsPath(configDir);
  const current = loadMetrics(configDir, now);
  const next: ActivationMetrics = {
    ...current,
    approvalsPrompted: current.approvalsPrompted + 1,
  };
  try {
    writeAtomic(file, next);
  } catch {
    // swallow
  }
}

/** Record an approval being acted on (approved or rejected — not a timeout). */
export function recordApprovalCompleted(
  configDir?: string,
  now: number = Date.now(),
): void {
  if (!isRecordingAllowed()) return;
  const file = resolveMetricsPath(configDir);
  const current = loadMetrics(configDir, now);
  const next: ActivationMetrics = {
    ...current,
    approvalsCompleted: current.approvalsCompleted + 1,
  };
  try {
    writeAtomic(file, next);
  } catch {
    // swallow
  }
}

/** Derive a dashboard-friendly summary from a metrics record. Pure function. */
export function computeSummary(
  metrics: ActivationMetrics,
  now: number = Date.now(),
): ActivationSummary {
  const timeToFirst =
    metrics.firstRecipeRunAt !== null
      ? Math.max(0, metrics.firstRecipeRunAt - metrics.installedAt)
      : null;

  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  let runsLast7 = 0;
  let activeDays = 0;
  for (const [key, count] of Object.entries(metrics.recipeRunsByDay)) {
    // Reconstruct timestamp at UTC midnight for the day bucket.
    const [y, m, d] = key.split("-").map(Number);
    if (y === undefined || m === undefined || d === undefined) continue;
    const bucket = Date.UTC(y, m - 1, d);
    if (bucket >= sevenDaysAgo && count > 0) {
      runsLast7 += count;
      activeDays += 1;
    }
  }

  const approvalCompletionRate =
    metrics.approvalsPrompted > 0
      ? Math.min(1, metrics.approvalsCompleted / metrics.approvalsPrompted)
      : null;

  return {
    installedAt: metrics.installedAt,
    firstRecipeRunAt: metrics.firstRecipeRunAt,
    timeToFirstRecipeRunMs: timeToFirst,
    recipeRunsTotal: metrics.recipeRunsTotal,
    recipeRunsLast7Days: runsLast7,
    activeDaysLast7: activeDays,
    approvalCompletionRate,
    approvalsPrompted: metrics.approvalsPrompted,
    approvalsCompleted: metrics.approvalsCompleted,
  };
}
