"use client";
import { useMemo, useState } from "react";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

type TraceType = "approval" | "enrichment" | "recipe_run" | "decision";

interface DecisionTrace {
  traceType: TraceType;
  ts: number;
  key: string;
  summary: string;
  body: Record<string, unknown>;
}

interface TracesResponse {
  traces: DecisionTrace[];
  count: number;
  sources: {
    approval: boolean;
    enrichment: boolean;
    recipe_run: boolean;
    decision: boolean;
  };
}

const TYPE_LABELS: Record<TraceType, string> = {
  approval: "Approval",
  enrichment: "Enrichment",
  recipe_run: "Recipe run",
  decision: "Decision",
};

const TYPE_COLORS: Record<TraceType, string> = {
  approval: "var(--warn, #d97706)",
  enrichment: "var(--ok, #059669)",
  recipe_run: "var(--fg-2)",
  decision: "#a78bfa",
};

export default function TracesPage() {
  const [filter, setFilter] = useState<TraceType | "all">("all");
  const [keyQuery, setKeyQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("traceType", filter);
    if (keyQuery.trim()) params.set("key", keyQuery.trim());
    params.set("limit", "200");
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [filter, keyQuery]);

  const { data, error, loading } = useBridgeFetch<TracesResponse>(
    `/api/bridge/traces${qs}`,
    { intervalMs: 3000 },
  );

  const traces = data?.traces ?? [];
  const sources = data?.sources;

  const toggle = (rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Traces</h1>
          <div className="page-head-sub">
            Unified decision trail — approvals, enrichment links, recipe runs.
          </div>
        </div>
        <span className="pill muted">
          {traces.length} trace{traces.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          marginBottom: "var(--s-4)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          {(
            ["all", "approval", "enrichment", "recipe_run", "decision"] as const
          ).map(
            (f) => {
              const active = filter === f;
              return (
                <button
                  type="button"
                  key={f}
                  onClick={() => setFilter(f)}
                  className={active ? "pill" : "pill muted"}
                  style={{
                    cursor: "pointer",
                    textTransform: "capitalize",
                    ...(active && {
                      background: "var(--accent, #8b5cf6)",
                      color: "var(--bg-0, #0a0a0a)",
                      borderColor: "var(--accent, #8b5cf6)",
                      fontWeight: 600,
                    }),
                  }}
                >
                  {f === "all" ? "All" : TYPE_LABELS[f as TraceType]}
                </button>
              );
            },
          )}
        </div>
        <input
          type="text"
          value={keyQuery}
          onChange={(e) => setKeyQuery(e.target.value)}
          placeholder="filter by key (sessionId, sha, taskId…)"
          style={{
            flex: 1,
            minWidth: 240,
            padding: "6px 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            background: "var(--bg-2)",
            border: "1px solid var(--bg-3)",
            borderRadius: 4,
            color: "var(--fg-0)",
          }}
        />
      </div>

      {sources && (
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-3)",
            marginBottom: "var(--s-3)",
          }}
        >
          Sources:{" "}
          {(Object.entries(sources) as [TraceType, boolean][])
            .filter(([, avail]) => avail)
            .map(([t]) => TYPE_LABELS[t])
            .join(" · ") || "none available"}
        </div>
      )}

      {error && <div className="alert-err">Unreachable: {error}</div>}

      {!loading && traces.length === 0 && !error ? (
        <div className="empty-state">
          <h3>
            {filter === "all" && !keyQuery
              ? "No traces yet"
              : "No matching traces"}
          </h3>
          <p>
            {filter === "all" && !keyQuery
              ? "Traces will appear once the bridge records approval decisions, enrichment links, or recipe runs."
              : `No ${filter === "all" ? "traces" : TYPE_LABELS[filter as TraceType].toLowerCase()} traces${keyQuery ? ` matching "${keyQuery}"` : ""}.`}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          {traces.map((t) => {
            const rowKey = `${t.traceType}:${t.ts}:${t.key}`;
            const isOpen = expanded.has(rowKey);
            return (
              <div
                key={rowKey}
                className="card"
                style={{ padding: "var(--s-3)" }}
              >
                <button
                  type="button"
                  onClick={() => toggle(rowKey)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--s-3)",
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textAlign: "left",
                    color: "inherit",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 3,
                      color: TYPE_COLORS[t.traceType],
                      border: `1px solid ${TYPE_COLORS[t.traceType]}`,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      flexShrink: 0,
                    }}
                  >
                    {TYPE_LABELS[t.traceType]}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--fg-2)",
                      flexShrink: 0,
                    }}
                  >
                    {t.key}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: "var(--fg-1)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.summary}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--fg-3)",
                      flexShrink: 0,
                    }}
                  >
                    {relTime(t.ts)}
                  </span>
                </button>
                {isOpen && (
                  <pre
                    style={{
                      marginTop: "var(--s-3)",
                      padding: "var(--s-3)",
                      background: "var(--bg-2)",
                      borderRadius: 4,
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {JSON.stringify(t.body, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
