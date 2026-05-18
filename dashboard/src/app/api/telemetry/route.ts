/**
 * Reads the self-hosted analytics receiver's JSONL files and returns an
 * aggregated summary. Reads files in DASHBOARD_TELEMETRY_DIR (default
 * /var/lib/analytics). Gated by the dashboard's existing session auth
 * via middleware — single-user password = effectively admin-only.
 *
 * Query params:
 *   days   — how many days back to include (default 7, max 90)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_DIR = "/var/lib/analytics";
const MAX_DAYS = 90;
const MAX_BYTES_PER_FILE = 16 * 1024 * 1024; // 16 MB safety cap

interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

interface Summary {
  bridgeVersion?: string;
  sessionDurationMs?: number;
  toolStats?: ToolStat[];
  installSalt?: string;
  nodeVersion?: string;
  osFamily?: string;
}

interface Event extends Summary {
  receivedAt: string; // derived from filename (UTC date)
}

function listDays(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function readDay(dir: string, day: string): Promise<Event[]> {
  const file = path.join(dir, `${day}.jsonl`);
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES_PER_FILE) return [];
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const out: Event[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Summary;
      out.push({ ...obj, receivedAt: day });
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function aggregate(events: Event[]) {
  const totalEvents = events.length;
  const totalSessionMs = events.reduce(
    (a, e) => a + (typeof e.sessionDurationMs === "number" ? e.sessionDurationMs : 0),
    0,
  );

  // by-tool
  const byTool = new Map<string, { calls: number; errors: number; p95Max: number }>();
  for (const e of events) {
    for (const t of e.toolStats ?? []) {
      const cur = byTool.get(t.tool) ?? { calls: 0, errors: 0, p95Max: 0 };
      cur.calls += t.calls;
      cur.errors += t.errors;
      cur.p95Max = Math.max(cur.p95Max, t.p95Ms);
      byTool.set(t.tool, cur);
    }
  }
  const tools = Array.from(byTool.entries())
    .map(([tool, s]) => ({ tool, ...s }))
    .sort((a, b) => b.calls - a.calls);

  // by-day
  const byDay = new Map<string, number>();
  for (const e of events) {
    byDay.set(e.receivedAt, (byDay.get(e.receivedAt) ?? 0) + 1);
  }
  const days = Array.from(byDay.entries())
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // by-install (salt — dedupes repeated installs from same machine)
  const byInstall = new Map<string, number>();
  for (const e of events) {
    if (typeof e.installSalt === "string") {
      byInstall.set(e.installSalt, (byInstall.get(e.installSalt) ?? 0) + 1);
    }
  }
  const installs = byInstall.size;

  // by-version
  const byVersion = new Map<string, number>();
  for (const e of events) {
    const v = e.bridgeVersion ?? "<unknown>";
    byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
  }
  const versions = Array.from(byVersion.entries())
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.count - a.count);

  // recent (last 20)
  const recent = events.slice(-20).reverse().map((e) => ({
    receivedAt: e.receivedAt,
    bridgeVersion: e.bridgeVersion,
    sessionDurationMs: e.sessionDurationMs,
    toolCount: e.toolStats?.reduce((a, t) => a + t.calls, 0) ?? 0,
    installSalt: e.installSalt ? `${e.installSalt.slice(0, 6)}…` : undefined,
  }));

  return { totalEvents, totalSessionMs, installs, tools, days, versions, recent };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const daysParam = Number.parseInt(url.searchParams.get("days") ?? "7", 10);
  const days = Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 7, 1), MAX_DAYS);
  const dir = process.env.DASHBOARD_TELEMETRY_DIR ?? DEFAULT_DIR;

  let directoryExists = true;
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) directoryExists = false;
  } catch {
    directoryExists = false;
  }

  if (!directoryExists) {
    return NextResponse.json(
      {
        directory: dir,
        directoryExists: false,
        message:
          "Telemetry directory not found. Set DASHBOARD_TELEMETRY_DIR to the JSONL output dir of the analytics receiver (default /var/lib/analytics).",
      },
      { status: 200 },
    );
  }

  const dayList = listDays(days);
  const allEvents: Event[] = [];
  for (const d of dayList) {
    allEvents.push(...(await readDay(dir, d)));
  }

  const summary = aggregate(allEvents);
  return NextResponse.json({
    directory: dir,
    directoryExists: true,
    windowDays: days,
    ...summary,
  });
}
