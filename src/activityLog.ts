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

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const MAX_PERSIST_LINES = 10_000;
const MAX_PERSIST_BYTES = 1024 * 1024; // 1MB

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private lifecycleEntries: LifecycleEntry[] = [];
  private nextId = 1;
  private maxEntries: number;
  private persistPath: string | null;
  private readonly listeners = new Set<ActivityListener>();

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
            this._rotateDisk();
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

  private _rotateDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, "utf8");
      let lines = raw.split("\n").filter((l) => l.trim());
      // Step 1: trim by line count
      if (lines.length > MAX_PERSIST_LINES) {
        lines = lines.slice(-MAX_PERSIST_LINES);
      }
      // Step 2: if still over byte limit (e.g. a few very long lines survived),
      // halve the line array repeatedly until under the byte budget.
      // This prevents O(N) disk-thrashing on every append.
      while (
        lines.join("\n").length + 1 > MAX_PERSIST_BYTES &&
        lines.length > 1
      ) {
        lines = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
      }
      fs.writeFileSync(this.persistPath, `${lines.join("\n")}\n`);
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

  toPrometheus(): string {
    const s = this.stats();
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
    lines.push("# HELP bridge_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE bridge_uptime_seconds gauge");
    lines.push(`bridge_uptime_seconds ${Math.floor(process.uptime())}`);
    return `${lines.join("\n")}\n`;
  }

  stats(): Record<
    string,
    { count: number; avgDurationMs: number; errors: number }
  > {
    const map = new Map<
      string,
      { count: number; totalMs: number; errors: number }
    >();
    for (const entry of this.entries) {
      const s = map.get(entry.tool) ?? { count: 0, totalMs: 0, errors: 0 };
      s.count++;
      s.totalMs += entry.durationMs;
      if (entry.status === "error") s.errors++;
      map.set(entry.tool, s);
    }
    const result: Record<
      string,
      { count: number; avgDurationMs: number; errors: number }
    > = {};
    for (const [tool, s] of map) {
      result[tool] = {
        count: s.count,
        avgDurationMs: Math.round(s.totalMs / s.count),
        errors: s.errors,
      };
    }
    return result;
  }
}
