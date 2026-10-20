/**
 * The `@every <n><unit>` schedule form, shared by the scheduler and
 * `recipe lint` so the two cannot disagree about what is accepted.
 *
 * Floor: one second, the finest a cron expression can express (six-field
 * form). `@every 1ms` used to parse, lint clean and fire a full recipe run
 * every millisecond (Private/52 LOW).
 */

export const MIN_INTERVAL_MS = 1000;

export type IntervalParse =
  | { ok: true; intervalMs: number }
  | { ok: false; reason: "not_interval" | "zero" | "below_minimum" };

export function parseEveryInterval(schedule: string): IntervalParse {
  const m = /^@every\s+(\d+)\s*(ms|s|m|h)$/i.exec(schedule.trim());
  if (!m) return { ok: false, reason: "not_interval" };
  const n = Number.parseInt(m[1] as string, 10);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "zero" };
  const unit = (m[2] as string).toLowerCase();
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const intervalMs = n * multiplier;
  if (intervalMs < MIN_INTERVAL_MS)
    return { ok: false, reason: "below_minimum" };
  return { ok: true, intervalMs };
}
