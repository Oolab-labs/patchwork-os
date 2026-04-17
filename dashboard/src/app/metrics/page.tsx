"use client";
import { useEffect, useMemo, useState } from "react";
import { relTime } from "@/components/time";

interface Metric {
  name: string;
  help?: string;
  value: number;
  labels?: Record<string, string>;
}

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [err, setErr] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch("/api/bridge/metrics");
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

  const groups = useMemo(() => categorize(metrics), [metrics]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <div className="page-head-sub">
            Prometheus counters from the bridge process.
          </div>
        </div>
        {updatedAt && (
          <span className="pill muted">updated {relTime(updatedAt)}</span>
        )}
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {metrics.length === 0 && !err ? (
        <div className="empty-state">
          <h3>No metrics yet</h3>
          <p>Metrics appear once the bridge begins serving tool calls.</p>
        </div>
      ) : (
        Object.entries(groups).map(([title, rows]) => (
          <div key={title} className="metrics-group">
            <div className="metrics-group-title">{title}</div>
            <div className="metrics-grid">
              {Object.entries(rows).map(([name, list]) => (
                <div key={name} className="metric-card">
                  <div className="metric-card-name" title={list[0].help ?? name}>
                    {name}
                  </div>
                  {list.length === 1 && !list[0].labels ? (
                    <div className="metric-card-value">
                      {formatNum(list[0].value)}
                    </div>
                  ) : (
                    <ul>
                      {list.slice(0, 8).map((r, i) => (
                        <li key={i}>
                          <span className="key">{labelStr(r.labels)}</span>
                          <span className="val">{formatNum(r.value)}</span>
                        </li>
                      ))}
                      {list.length > 8 && (
                        <li>
                          <span className="key">
                            +{list.length - 8} more
                          </span>
                          <span />
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function categorize(metrics: Metric[]): Record<string, Record<string, Metric[]>> {
  const out: Record<string, Record<string, Metric[]>> = {
    "Tool calls": {},
    "Uptime & process": {},
    "Rate limits": {},
    Other: {},
  };
  for (const m of metrics) {
    const n = m.name.toLowerCase();
    let bucket = "Other";
    if (/tool|call|invoc|approval/.test(n)) bucket = "Tool calls";
    else if (/uptime|process|memory|heap|cpu/.test(n)) bucket = "Uptime & process";
    else if (/rate|throttle|limit|token_bucket/.test(n)) bucket = "Rate limits";
    (out[bucket][m.name] ??= []).push(m);
  }
  // drop empty buckets
  for (const key of Object.keys(out)) {
    if (Object.keys(out[key]).length === 0) delete out[key];
  }
  return out;
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

function labelStr(labels?: Record<string, string>): string {
  if (!labels) return "(value)";
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}
