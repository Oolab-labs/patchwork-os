export interface ActivityEntry {
  id: number;
  timestamp: string;
  tool: string;
  durationMs: number;
  status: "success" | "error";
  errorMessage?: string;
}

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private nextId = 1;
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  record(
    tool: string,
    durationMs: number,
    status: "success" | "error",
    errorMessage?: string,
  ): void {
    this.entries.push({
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      tool,
      durationMs,
      status,
      errorMessage,
    });
    if (this.entries.length > this.maxEntries * 1.2) {
      // Batch eviction: drop the oldest 20% instead of shift() on every insert
      this.entries = this.entries.slice(-this.maxEntries);
    }
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
    lines.push("# HELP bridge_tool_calls_total Total tool calls by tool name and status");
    lines.push("# TYPE bridge_tool_calls_total counter");
    for (const [tool, data] of Object.entries(s)) {
      const t = escapeLabelValue(tool);
      lines.push(`bridge_tool_calls_total{tool="${t}",status="success"} ${data.count - data.errors}`);
      lines.push(`bridge_tool_calls_total{tool="${t}",status="error"} ${data.errors}`);
    }
    lines.push("# HELP bridge_tool_duration_ms_avg Average tool duration in milliseconds");
    lines.push("# TYPE bridge_tool_duration_ms_avg gauge");
    for (const [tool, data] of Object.entries(s)) {
      const t = escapeLabelValue(tool);
      lines.push(`bridge_tool_duration_ms_avg{tool="${t}"} ${data.avgDurationMs}`);
    }
    lines.push("# HELP bridge_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE bridge_uptime_seconds gauge");
    lines.push(`bridge_uptime_seconds ${Math.floor(process.uptime())}`);
    return lines.join("\n") + "\n";
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
