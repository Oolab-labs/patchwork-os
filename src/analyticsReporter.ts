/**
 * Periodic + shutdown usage reporting.
 *
 * Telemetry used to be sent only at bridge shutdown. Long-running bridges
 * (launchd services, containers) almost never shut down, so they never
 * reported. The reporter sends on an interval and once more at shutdown.
 *
 * Each activity entry is counted exactly once: a send covers entries newer
 * than the previous send's cutoff, and the cutoff advances even when the send
 * fails (a failed send is dropped, never retried — retrying would double-count
 * if the collector had in fact stored it). Activity while telemetry is not
 * opted in advances the cutoff too, so opting in later never uploads history
 * the user had not consented to.
 */

import type { ActivityEntry } from "./activityTypes.js";
import { type AnalyticsSummary, buildSummary } from "./analyticsAggregator.js";

export const DEFAULT_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReporterDeps {
  /** Current in-memory activity entries (any order). */
  entries: () => readonly ActivityEntry[];
  /** True when the user has opted in. Checked at every flush. */
  enabled: () => boolean;
  bridgeVersion: string;
  salt: () => string;
  send: (summary: AnalyticsSummary) => Promise<void>;
  now?: () => number;
}

export class AnalyticsReporter {
  private readonly deps: ReporterDeps;
  private cutoffMs: number;
  private windowStartMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(deps: ReporterDeps) {
    this.deps = deps;
    const now = (deps.now ?? Date.now)();
    this.cutoffMs = now;
    this.windowStartMs = now;
  }

  start(intervalMs: number = DEFAULT_REPORT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send everything since the last cutoff. Never rejects. Serialised. */
  flush(): Promise<void> {
    const run = (this.inFlight ?? Promise.resolve()).then(() => this.doFlush());
    this.inFlight = run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    return run;
  }

  private async doFlush(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const since = this.cutoffMs;
    const batch = this.deps.entries().filter((e) => {
      const t = Date.parse(e.timestamp);
      return Number.isFinite(t) && t > since && t <= now;
    });
    const windowMs = now - this.windowStartMs;
    // Advance BEFORE sending: success, failure and opted-out all consume the
    // window, so nothing is ever counted twice or uploaded retroactively.
    this.cutoffMs = now;
    if (batch.length === 0) return;
    this.windowStartMs = now;
    if (!this.deps.enabled()) return;
    try {
      const summary = buildSummary(
        batch,
        Math.max(0, windowMs),
        this.deps.bridgeVersion,
        this.deps.salt(),
      );
      await this.deps.send(summary);
    } catch {
      // Dropped by design — see the header.
    }
  }
}
