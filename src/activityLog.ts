export type {
  ActivityEntry,
  ActivityListener,
  LifecycleEntry,
  TimelineEntry,
} from "./activityTypes.js";

import fs from "node:fs";
import path from "node:path";
import type {
  ActivityEntry,
  ActivityListener,
  LifecycleEntry,
  TimelineEntry,
} from "./activityTypes.js";
import {
  computeCoOccurrence,
  computePercentiles,
  computeStats,
  computeWindowedStats,
} from "./fp/activityAnalytics.js";

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const MAX_PERSIST_LINES = 10_000;
const MAX_PERSIST_BYTES = 1024 * 1024; // 1MB

/** Max duration samples kept per tool for percentile calculation. */
const MAX_DURATION_SAMPLES = 1_000;

/** Default sliding window for co-occurrence (5 minutes). */
export const DEFAULT_CO_OCCURRENCE_WINDOW_MS = 5 * 60 * 1_000;

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private lifecycleEntries: LifecycleEntry[] = [];
  private nextId = 1;
  private maxEntries: number;
  private persistPath: string | null;
  private readonly listeners = new Set<ActivityListener>();
  private rateLimitRejections = 0;

  /**
   * Per-tool bounded ring of duration samples used for percentile computation.
   * Capped at MAX_DURATION_SAMPLES per tool to bound memory.
   */
  private readonly durationSamples = new Map<string, number[]>();

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.persistPath = null;
  }

  /**
   * Subscribe to real-time activity events.
   * @returns An unsubscribe function — call it to stop receiving events.
   */
  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPersistPath(p: string): void {
    this.persistPath = p;
    this._loadFromDisk();
  }

  private _loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const line of lines.slice(-this.maxEntries)) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.kind === "tool") {
            if (
              typeof obj.tool !== "string" ||
              typeof obj.durationMs !== "number" ||
              obj.durationMs < 0 ||
              !Number.isFinite(obj.durationMs) ||
              (obj.status !== "success" && obj.status !== "error") ||
              typeof obj.timestamp !== "string"
            ) {
              process.stderr.write(
                `[activityLog] Skipping invalid tool entry (missing/wrong-type fields): ${line}\n`,
              );
              continue;
            }
            this.entries.push(obj as unknown as ActivityEntry);
            if (typeof obj.id === "number" && Number.isFinite(obj.id)) {
              this.nextId = Math.max(this.nextId, obj.id + 1);
            }
          } else if (obj.kind === "lifecycle") {
            this.lifecycleEntries.push(obj as unknown as LifecycleEntry);
            if (typeof obj.id === "number" && Number.isFinite(obj.id)) {
              this.nextId = Math.max(this.nextId, obj.id + 1);
            }
          }
        } catch (err) {
          process.stderr.write(
            `[activityLog] Skipping malformed JSON line: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        process.stderr.write(
          `[activityLog] Failed to load persist file: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  private _appendToDisk(
    kind: string,
    entry: ActivityEntry | LifecycleEntry,
  ): void {
    if (!this.persistPath) return;
    const persistPath = this.persistPath;
    // Fire-and-forget async — never block the event loop on disk I/O
    void (async () => {
      try {
        const dir = path.dirname(persistPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const line = `${JSON.stringify({ kind, ...entry })}\n`;
        // Rotate first if file exceeds limits, then always append the current entry
        try {
          const stat = await fs.promises.stat(persistPath);
          if (stat.size > MAX_PERSIST_BYTES) {
            await this._rotateDisk();
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            process.stderr.write(
              `[activityLog] Failed to stat persist file for rotation: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        // Ensure file exists with restrictive permissions (0o600) before appending
        try {
          const fd = await fs.promises.open(persistPath, "a", 0o600);
          await fd.close();
        } catch {
          // ignore — appendFile below will create the file if needed
        }
        await fs.promises.appendFile(persistPath, line, { mode: 0o600 });
      } catch (err) {
        process.stderr.write(
          `[activityLog] Disk persistence failed (best-effort): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    })();
  }

  private async _rotateDisk(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await fs.promises.readFile(this.persistPath, "utf8");
      let lines = raw.split("\n").filter((l) => l.trim());
      // Step 1: trim by line count
      if (lines.length > MAX_PERSIST_LINES) {
        lines = lines.slice(-MAX_PERSIST_LINES);
      }
      // Step 2: if still over byte limit (e.g. a few very long lines survived),
      // halve the line array repeatedly until under the byte budget.
      // This prevents O(N) disk-thrashing on every append.
      let joined = lines.join("\n");
      while (joined.length + 1 > MAX_PERSIST_BYTES && lines.length > 1) {
        lines = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
        joined = lines.join("\n");
      }
      await fs.promises.writeFile(this.persistPath, `${lines.join("\n")}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      process.stderr.write(
        `[activityLog] Rotation failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  record(
    tool: string,
    durationMs: number,
    status: "success" | "error",
    errorMessage?: string,
  ): void {
    const entry: ActivityEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      tool,
      durationMs,
      status,
      errorMessage,
    };
    this.entries.push(entry);
    this._appendToDisk("tool", entry);

    // Accumulate duration sample for percentile tracking
    let samples = this.durationSamples.get(tool);
    if (!samples) {
      samples = [];
      this.durationSamples.set(tool, samples);
    }
    samples.push(durationMs);
    if (samples.length > MAX_DURATION_SAMPLES * 1.2) {
      // Batch eviction: keep newest MAX_DURATION_SAMPLES to amortise splice cost
      this.durationSamples.set(tool, samples.slice(-MAX_DURATION_SAMPLES));
    }

    for (const listener of this.listeners) {
      try {
        listener("tool", entry);
      } catch {
        /* listeners must not crash the log */
      }
    }
    if (this.entries.length > this.maxEntries * 1.2) {
      // Batch eviction: drop the oldest 20% instead of shift() on every insert
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  recordEvent(event: string, metadata?: Record<string, unknown>): void {
    const entry: LifecycleEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      event,
      metadata,
    };
    this.lifecycleEntries.push(entry);
    this._appendToDisk("lifecycle", entry);
    for (const listener of this.listeners) {
      try {
        listener("lifecycle", entry);
      } catch {
        /* listeners must not crash the log */
      }
    }
    if (this.lifecycleEntries.length > this.maxEntries * 1.2) {
      this.lifecycleEntries = this.lifecycleEntries.slice(-this.maxEntries);
    }
  }

  /**
   * Return the highest ID assigned so far, or 0 if nothing has been recorded.
   * Used by watchActivityLog to return an accurate lastId on long-poll timeout
   * so clients don't re-poll from the same position indefinitely.
   */
  getHighestId(): number {
    return Math.max(0, this.nextId - 1);
  }

  /**
   * Look up a single approval_decision lifecycle entry by callId. Returns
   * the decision entry plus tool entries + lifecycle events for the same
   * session in the ±60s window around the decision (for context).
   *
   * The dashboard approval detail view is the only caller; keep the window
   * tight so we don't walk unbounded history for each lookup.
   */
  findApprovalByCallId(callId: string): {
    decision: LifecycleEntry | null;
    nearby: TimelineEntry[];
  } {
    const decision =
      this.lifecycleEntries.find(
        (e) =>
          e.event === "approval_decision" &&
          typeof e.metadata?.callId === "string" &&
          e.metadata.callId === callId,
      ) ?? null;
    if (!decision) return { decision: null, nearby: [] };

    const sessionId =
      typeof decision.metadata?.sessionId === "string"
        ? decision.metadata.sessionId
        : undefined;
    if (!sessionId) return { decision, nearby: [] };

    const tDecision = Date.parse(decision.timestamp);
    const windowMs = 60_000;
    const lo = tDecision - windowMs;
    const hi = tDecision + windowMs;

    const tools: TimelineEntry[] = this.entries
      .filter((e) => {
        const t = Date.parse(e.timestamp);
        return t >= lo && t <= hi;
      })
      .map((e) => ({ kind: "tool" as const, ...e }));

    const lifecycle: TimelineEntry[] = this.lifecycleEntries
      .filter((e) => {
        if (e.id === decision.id) return false;
        if (e.metadata?.sessionId !== sessionId) return false;
        const t = Date.parse(e.timestamp);
        return t >= lo && t <= hi;
      })
      .map((e) => ({ kind: "lifecycle" as const, ...e }));

    const nearby = [...tools, ...lifecycle].sort((a, b) => a.id - b.id);
    return { decision, nearby };
  }

  /**
   * Return all lifecycle entries whose metadata.sessionId matches. Sorted
   * by id ascending (oldest first). Used by the dashboard session detail
   * view to render a per-session event stream.
   *
   * Tool entries aren't returned because they don't carry a sessionId —
   * correlation would require a time-window heuristic, which is best-effort
   * at best. Callers who need tool activity for a session can cross-reference
   * by time bounds themselves.
   */
  querySessionLifecycle(sessionId: string, limit = 100): LifecycleEntry[] {
    const matches: LifecycleEntry[] = [];
    for (const e of this.lifecycleEntries) {
      if (e.metadata?.sessionId === sessionId) matches.push(e);
    }
    return matches.slice(-limit);
  }

  queryTimeline(opts?: { last?: number }): TimelineEntry[] {
    const tools: TimelineEntry[] = this.entries.map((e) => ({
      kind: "tool" as const,
      ...e,
    }));
    const lifecycle: TimelineEntry[] = this.lifecycleEntries.map((e) => ({
      kind: "lifecycle" as const,
      ...e,
    }));
    const combined = [...tools, ...lifecycle].sort((a, b) => a.id - b.id);
    const last = Math.min(opts?.last ?? 50, 200);
    return combined.slice(-last);
  }

  query(opts?: {
    tool?: string;
    status?: string;
    last?: number;
  }): ActivityEntry[] {
    let result = this.entries;
    if (opts?.tool) result = result.filter((e) => e.tool === opts.tool);
    if (opts?.status) result = result.filter((e) => e.status === opts.status);
    const last = Math.min(opts?.last ?? 50, 200);
    return result.slice(-last);
  }

  toPrometheus(extras?: {
    activeToolCalls?: number;
    rateLimitRejected?: number;
    extensionDisconnects?: number;
  }): string {
    const s = this.stats();
    const p = this.percentiles();
    const lines: string[] = [];
    lines.push(
      "# HELP bridge_tool_calls_total Total tool calls by tool name and status",
    );
    lines.push("# TYPE bridge_tool_calls_total counter");
    for (const [tool, data] of Object.entries(s)) {
      const t = escapeLabelValue(tool);
      lines.push(
        `bridge_tool_calls_total{tool="${t}",status="success"} ${data.count - data.errors}`,
      );
      lines.push(
        `bridge_tool_calls_total{tool="${t}",status="error"} ${data.errors}`,
      );
    }
    lines.push(
      "# HELP bridge_tool_duration_ms_avg Average tool duration in milliseconds",
    );
    lines.push("# TYPE bridge_tool_duration_ms_avg gauge");
    for (const [tool, data] of Object.entries(s)) {
      const t = escapeLabelValue(tool);
      lines.push(
        `bridge_tool_duration_ms_avg{tool="${t}"} ${data.avgDurationMs}`,
      );
    }
    // Per-tool latency percentiles
    if (Object.keys(p).length > 0) {
      lines.push(
        "# HELP bridge_tool_duration_p50_ms p50 latency per tool (ms)",
      );
      lines.push("# TYPE bridge_tool_duration_p50_ms gauge");
      for (const [tool, data] of Object.entries(p)) {
        const t = escapeLabelValue(tool);
        lines.push(`bridge_tool_duration_p50_ms{tool="${t}"} ${data.p50}`);
      }
      lines.push(
        "# HELP bridge_tool_duration_p95_ms p95 latency per tool (ms)",
      );
      lines.push("# TYPE bridge_tool_duration_p95_ms gauge");
      for (const [tool, data] of Object.entries(p)) {
        const t = escapeLabelValue(tool);
        lines.push(`bridge_tool_duration_p95_ms{tool="${t}"} ${data.p95}`);
      }
      lines.push(
        "# HELP bridge_tool_duration_p99_ms p99 latency per tool (ms)",
      );
      lines.push("# TYPE bridge_tool_duration_p99_ms gauge");
      for (const [tool, data] of Object.entries(p)) {
        const t = escapeLabelValue(tool);
        lines.push(`bridge_tool_duration_p99_ms{tool="${t}"} ${data.p99}`);
      }
    }
    lines.push("# HELP bridge_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE bridge_uptime_seconds gauge");
    lines.push(`bridge_uptime_seconds ${Math.floor(process.uptime())}`);
    if (extras?.activeToolCalls !== undefined) {
      lines.push(
        "# HELP bridge_active_tool_calls Currently executing tool calls",
      );
      lines.push("# TYPE bridge_active_tool_calls gauge");
      lines.push(`bridge_active_tool_calls ${extras.activeToolCalls}`);
    }
    if (extras?.rateLimitRejected !== undefined) {
      lines.push(
        "# HELP bridge_rate_limit_rejected_total Total rate-limit rejections",
      );
      lines.push("# TYPE bridge_rate_limit_rejected_total counter");
      lines.push(
        `bridge_rate_limit_rejected_total ${extras.rateLimitRejected}`,
      );
    }
    if (extras?.extensionDisconnects !== undefined) {
      lines.push(
        "# HELP bridge_extension_disconnects_total Total extension disconnects",
      );
      lines.push("# TYPE bridge_extension_disconnects_total counter");
      lines.push(
        `bridge_extension_disconnects_total ${extras.extensionDisconnects}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  stats(): Record<
    string,
    { count: number; avgDurationMs: number; errors: number }
  > {
    return computeStats(this.entries);
  }

  /**
   * Per-tool percentiles (p50/p95/p99) computed from the bounded duration
   * sample buffer. Returns null for any tool with fewer than 2 samples.
   */
  percentiles(): Record<
    string,
    { p50: number; p95: number; p99: number; sampleCount: number }
  > {
    return computePercentiles(this.durationSamples);
  }

  /** Increment the rate-limit rejection counter. */
  recordRateLimitRejection(): void {
    this.rateLimitRejections++;
  }

  /** Return total rate-limit rejections recorded since startup. */
  getRateLimitRejections(): number {
    return this.rateLimitRejections;
  }

  /**
   * Per-tool stats within a sliding time window (reverse scan stops outside cutoff).
   * Returns Record<tool, {count, errors, avgDurationMs}>.
   */
  windowedStats(
    windowMs: number,
  ): Record<string, { count: number; errors: number; avgDurationMs: number }> {
    return computeWindowedStats(this.entries, windowMs, Date.now());
  }

  /**
   * Tool-pair co-occurrence within a sliding time window.
   * Counts how many times tool B was called within `windowMs` after tool A,
   * across all entries in the in-memory buffer. Pairs are ordered (A < B
   * alphabetically) to avoid double-counting. Returns sorted by count desc.
   */
  coOccurrence(
    windowMs = DEFAULT_CO_OCCURRENCE_WINDOW_MS,
  ): { pair: string; count: number }[] {
    return computeCoOccurrence(this.entries, windowMs);
  }
}
