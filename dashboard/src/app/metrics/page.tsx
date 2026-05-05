"use client";
import { useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import { relTime } from "@/components/time";
import { MetricsDonut, HBarList, ErrorState, AnimatedNumber } from "@/components/patchwork";
import { AnalyticsTabs } from "@/components/AnalyticsTabs";
import type { DonutSegment, HBarItem } from "@/components/patchwork";

interface Metric {
  name: string;
  help?: string;
  value: number;
  labels?: Record<string, string>;
}

const DONUT_COLORS = [
  "var(--orange)",
  "var(--blue)",
  "var(--green)",
  "var(--red)",
  "var(--amber)",
  "var(--purple)",
];

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [err, setErr] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/metrics"));
        if (!res.ok) throw new Error(`/metrics ${res.status}`);
        const text = await res.text();
        setMetrics(parsePrometheus(text));
        setUpdatedAt(Date.now());
        setErr(undefined);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  const totalCalls = useMemo(() => {
    const rows = metrics.filter((m) => m.name === "bridge_tool_calls_total");
    // Prefer the labelless aggregate row if the bridge emits one; falling
    // back to summing per-label rows would double-count it.
    const aggregate = rows.find(
      (m) => !m.labels || Object.keys(m.labels).length === 0,
    );
    if (aggregate) return aggregate.value;
    return rows.reduce((s, m) => s + m.value, 0);
  }, [metrics]);

  const totalErrors = useMemo(
    () =>
      metrics
        .filter(
          (m) =>
            m.name === "bridge_tool_calls_total" &&
            (m.labels?.status === "error" ||
              m.labels?.outcome === "error" ||
              m.labels?.result === "error"),
        )
        .reduce((s, m) => s + m.value, 0),
    [metrics],
  );

  const successRate = useMemo(
    () =>
      totalCalls > 0
        ? ((totalCalls - totalErrors) / totalCalls * 100).toFixed(1)
        : null,
    [totalCalls, totalErrors],
  );

  const uptimeSeconds = useMemo(() => {
    const m = metrics.find(
      (m) => /uptime|process_uptime/i.test(m.name) && !m.labels,
    );
    return m?.value ?? null;
  }, [metrics]);

  const rateLimitCount = useMemo(
    () =>
      metrics
        .filter((m) => /rate|throttle|limit|token_bucket/i.test(m.name))
        .reduce((s, m) => s + m.value, 0),
    [metrics],
  );

  const toolCallDonut = useMemo<DonutSegment[]>(() => {
    const calls = metrics.filter(
      (m) => m.name === "bridge_tool_calls_total" && m.labels?.tool,
    );
    return calls
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
      .map((m, i) => ({
        label: m.labels!.tool!,
        value: m.value,
        color: DONUT_COLORS[i % DONUT_COLORS.length],
      }));
  }, [metrics]);

  const callsByToolStatus = useMemo(() => {
    const calls = metrics.filter(
      (m) => m.name === "bridge_tool_calls_total" && m.labels?.tool,
    );
    return calls
      .map((m) => {
        const status =
          m.labels?.status ||
          m.labels?.outcome ||
          m.labels?.result ||
          "success";
        return { tool: m.labels!.tool!, status, value: m.value };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);
  }, [metrics]);

  const durationHBar = useMemo<HBarItem[]>(() => {
    const dur = metrics.filter(
      (m) => m.name === "bridge_tool_duration_seconds_sum" && m.labels?.tool,
    );
    return dur
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((m, i) => ({
        label: m.labels!.tool!,
        value: parseFloat(m.value.toFixed(2)),
        color: DONUT_COLORS[i % DONUT_COLORS.length],
        sub: "s",
      }));
  }, [metrics]);

  return (
    <section>
      <AnalyticsTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Metrics — <span className="accent">Prometheus counters, exposed locally.</span>
          </h1>
          <div className="editorial-sub">
            polled every 3s · uptime {uptimeSeconds != null ? Math.round(uptimeSeconds) + "s" : "—"} · rate-limits {rateLimitCount}
          </div>
        </div>
        {updatedAt && (
          <span className="pill muted">updated {relTime(updatedAt)}</span>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0,1fr))",
          gap: "var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <div className="card" style={{ padding: "16px 20px", borderRadius: "var(--r-card)", borderLeft: "3px solid var(--orange)" }}>
          <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 6 }}>
            <span style={{ color: "var(--orange)", marginRight: 6 }}>{">_"}</span>Total calls
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>
            {metrics.length === 0 ? "—" : <AnimatedNumber value={totalCalls} />}
          </div>
        </div>
        <div className="card" style={{ padding: "16px 20px", borderRadius: "var(--r-card)", borderLeft: "3px solid var(--err)" }}>
          <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 6 }}>
            <span style={{ color: "var(--err)", marginRight: 6 }}>△</span>Errors
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 800, color: totalErrors > 0 ? "var(--err)" : "var(--ink-0)", lineHeight: 1 }}>
            {metrics.length === 0 ? "—" : <AnimatedNumber value={totalErrors} />}
          </div>
        </div>
        <div className="card" style={{ padding: "16px 20px", borderRadius: "var(--r-card)", borderLeft: "3px solid var(--green)" }}>
          <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 6 }}>
            <span style={{ color: "var(--green)", marginRight: 6 }}>✓</span>Success rate
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>
            {successRate !== null ? `${successRate}%` : "—"}
          </div>
          {successRate === null && (
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>no calls yet</div>
          )}
        </div>
        <div className="card" style={{ padding: "16px 20px", borderRadius: "var(--r-card)", borderLeft: "3px solid var(--blue)" }}>
          <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 6 }}>
            <span style={{ color: "var(--blue)", marginRight: 6 }}>◎</span>Uptime
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>
            {uptimeSeconds != null ? `${Math.round(uptimeSeconds)}s` : "—"}
          </div>
        </div>
      </div>

      {err && metrics.length === 0 && (
        <ErrorState
          title="Couldn't load metrics"
          description="The bridge isn't responding to /metrics."
          error={err}
          onRetry={() => window.location.reload()}
        />
      )}
      {err && metrics.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

      {/* Visual charts: donut + time-spent hbar */}
      {metrics.length > 0 && (toolCallDonut.length > 0 || durationHBar.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0,1fr))",
            gap: "var(--s-4)",
            marginBottom: "var(--s-5)",
            alignItems: "start",
          }}
        >
          {toolCallDonut.length > 0 && (
            <div className="card" style={{ padding: "16px 20px" }}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                  marginBottom: 12,
                }}
              >
                Calls by tool
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--s-4)", alignItems: "center" }}>
                <MetricsDonut segments={toolCallDonut} size={110} strokeWidth={16} label="calls" />
                <ul style={{ listStyle: "none", margin: 0, padding: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-1)", display: "flex", flexDirection: "column", gap: 4 }}>
                  {callsByToolStatus.map((row, i) => (
                    <li key={`${row.tool}-${row.status}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px dashed var(--line-2)", paddingBottom: 3 }}>
                      <span style={{ color: "var(--ink-2)" }}>
                        tool=<span style={{ color: "var(--ink-0)" }}>{row.tool}</span>, status=
                        <span style={{ color: row.status === "error" ? "var(--err)" : "var(--green)" }}>{row.status}</span>
                      </span>
                      <span style={{ color: "var(--ink-0)", fontWeight: 700 }}>· {row.value.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {durationHBar.length > 0 && (
            <div className="card" style={{ padding: "16px 20px" }}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                  marginBottom: 12,
                }}
              >
                Time spent (seconds)
              </div>
              <HBarList items={durationHBar} height={5} />
            </div>
          )}
        </div>
      )}

      {metrics.length === 0 && !err && (
        <div
          style={{
            border: "1.5px dashed var(--line-2)",
            borderRadius: "var(--r-card)",
            minHeight: 200,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "var(--s-5)",
            textAlign: "center",
          }}
        >
          <h3 style={{ color: "var(--ink-1)", marginBottom: 8 }}>No metrics yet</h3>
          <p style={{ color: "var(--ink-3)", fontSize: 13, maxWidth: 380, margin: 0 }}>
            Metrics appear once the bridge begins serving tool calls. Make a tool call or wait for the next scrape interval.
          </p>
        </div>
      )}
    </section>
  );
}


function parsePrometheus(text: string): Metric[] {
  const out: Metric[] = [];
  const helpMap: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# HELP ")) {
      const [, name, ...rest] = line.slice(7).split(" ");
      if (name) helpMap[name] = rest.join(" ");
      continue;
    }
    if (line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(.+)$/);
    if (!m) continue;
    const [, name, lbls, valStr] = m;
    const value = Number.parseFloat(valStr);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (lbls) {
      for (const pair of lbls.split(",")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        labels[pair.slice(0, eq).trim()] = pair
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, "");
      }
    }
    out.push({
      name,
      value,
      labels: Object.keys(labels).length ? labels : undefined,
      help: helpMap[name],
    });
  }
  return out;
}

