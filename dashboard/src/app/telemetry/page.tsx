"use client";

import { useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/patchwork";

interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
  p95Max: number;
}

interface RecentRow {
  receivedAt: string;
  bridgeVersion?: string;
  sessionDurationMs?: number;
  toolCount: number;
  installSalt?: string;
}

interface TelemetryResponse {
  directory: string;
  directoryExists: boolean;
  message?: string;
  windowDays?: number;
  totalEvents?: number;
  totalSessionMs?: number;
  installs?: number;
  tools?: ToolRow[];
  days?: { day: string; count: number }[];
  versions?: { version: string; count: number }[];
  recent?: RecentRow[];
}

const WINDOWS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export default function TelemetryPage() {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(apiPath(`/api/telemetry?days=${days}`))
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TelemetryResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const topVersion = useMemo(() => data?.versions?.[0]?.version ?? "—", [data]);

  if (loading && !data) {
    return <div style={{ padding: 24 }} aria-busy="true">Loading…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Telemetry</h1>
        <EmptyState title="Failed to load telemetry" description={error} />
      </div>
    );
  }
  if (!data) {
    return null;
  }
  if (!data.directoryExists) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Telemetry</h1>
        <EmptyState
          title="Telemetry directory not found"
          description={
            <>
              Looked for JSONL files in <code>{data.directory}</code>.
              Set <code>DASHBOARD_TELEMETRY_DIR</code> to the receiver's output
              directory (default <code>/var/lib/analytics</code>) and restart
              the dashboard.
            </>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ margin: 0 }}>Telemetry</h1>
          <p style={{ margin: "4px 0 0", color: "var(--fg-2)", fontSize: 14 }}>
            Self-hosted analytics receiver — events from opted-in bridge installs.
            Reading from <code>{data.directory}</code>.
          </p>
        </div>
        <div role="tablist" aria-label="Time window" style={{ display: "flex", gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              type="button"
              key={w.value}
              role="tab"
              aria-selected={w.value === days}
              onClick={() => setDays(w.value)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: w.value === days ? "var(--accent)" : "transparent",
                color: w.value === days ? "var(--accent-fg)" : "var(--fg)",
                cursor: "pointer",
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <StatCard label="Events" value={data.totalEvents ?? 0} foot={`window: ${data.windowDays}d`} />
        <StatCard label="Unique installs" value={data.installs ?? 0} foot="dedup by install salt" />
        <StatCard
          label="Total session time"
          value={fmtMs(data.totalSessionMs ?? 0)}
          foot="sum of sessionDurationMs"
        />
        <StatCard label="Top version" value={topVersion} foot="most events" />
      </section>

      <section>
        <h2 style={{ marginBottom: 8 }}>Tools (by total calls)</h2>
        {(data.tools ?? []).length === 0 ? (
          <EmptyState title="No tool calls in window" description="Either no installs are opted in or no sessions completed." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: 8 }}>Tool</th>
                  <th style={{ padding: 8, textAlign: "right" }}>Calls</th>
                  <th style={{ padding: 8, textAlign: "right" }}>Errors</th>
                  <th style={{ padding: 8, textAlign: "right" }}>p95 (max)</th>
                </tr>
              </thead>
              <tbody>
                {(data.tools ?? []).map((t) => (
                  <tr key={t.tool} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: 8, fontFamily: "var(--font-mono)" }}>{t.tool}</td>
                    <td style={{ padding: 8, textAlign: "right" }}>{t.calls.toLocaleString()}</td>
                    <td
                      style={{
                        padding: 8,
                        textAlign: "right",
                        color: t.errors > 0 ? "var(--err)" : "var(--fg-2)",
                      }}
                    >
                      {t.errors}
                    </td>
                    <td style={{ padding: 8, textAlign: "right" }}>{t.p95Max}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div>
          <h2 style={{ marginBottom: 8 }}>By version</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              {(data.versions ?? []).map((v) => (
                <tr key={v.version} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <td style={{ padding: 6, fontFamily: "var(--font-mono)" }}>{v.version}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>{v.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h2 style={{ marginBottom: 8 }}>By day</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              {(data.days ?? []).map((d) => (
                <tr key={d.day} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <td style={{ padding: 6, fontFamily: "var(--font-mono)" }}>{d.day}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: 8 }}>Recent (last 20)</h2>
        {(data.recent ?? []).length === 0 ? (
          <EmptyState title="No recent events" description="" />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: 6 }}>Received (UTC date)</th>
                <th style={{ padding: 6 }}>Version</th>
                <th style={{ padding: 6, textAlign: "right" }}>Tool calls</th>
                <th style={{ padding: 6, textAlign: "right" }}>Session</th>
                <th style={{ padding: 6 }}>Install</th>
              </tr>
            </thead>
            <tbody>
              {(data.recent ?? []).map((r, i) => (
                <tr key={`${r.receivedAt}-${i}`} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <td style={{ padding: 6, fontFamily: "var(--font-mono)" }}>{r.receivedAt}</td>
                  <td style={{ padding: 6, fontFamily: "var(--font-mono)" }}>{r.bridgeVersion ?? "—"}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>{r.toolCount}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>
                    {typeof r.sessionDurationMs === "number" ? fmtMs(r.sessionDurationMs) : "—"}
                  </td>
                  <td style={{ padding: 6, fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>
                    {r.installSalt ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
