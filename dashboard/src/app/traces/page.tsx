"use client";
import { Fragment, useMemo, useState } from "react";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { arr, isRecord, shape, type ShapeCheck } from "@/lib/validate";

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

const validateTraces: ShapeCheck<TracesResponse> = shape(
  "/traces",
  (raw, errors) => {
    if (!isRecord(raw)) {
      errors.push({ path: "$", reason: "expected object" });
      return null;
    }
    arr(raw, "traces", errors);
    if (typeof raw.count !== "number") {
      errors.push({ path: "count", reason: "expected number" });
    }
    if (!isRecord(raw.sources)) {
      errors.push({ path: "sources", reason: "expected object" });
    }
    if (errors.length > 0) return null;
    return raw as unknown as TracesResponse;
  },
);

const TYPE_LABELS: Record<TraceType, string> = {
  approval: "Approval",
  enrichment: "Enrichment",
  recipe_run: "Recipe run",
  decision: "Decision",
};

const TYPE_THEME: Record<
  TraceType,
  { fg: string; bg: string; pill: string }
> = {
  approval: { fg: "var(--amber)", bg: "var(--amber-soft)", pill: "warn" },
  enrichment: { fg: "var(--green)", bg: "var(--green-soft)", pill: "ok" },
  recipe_run: { fg: "var(--blue)", bg: "var(--blue-soft)", pill: "info" },
  decision: { fg: "var(--purple)", bg: "var(--purple-soft)", pill: "purp" },
};

// ------------------------------------------------------------------ detail panel

const SCALAR_KEYS_FIRST = ["status", "trigger", "recipeName", "taskId", "durationMs", "seq"];

function TraceDetail({
  body,
  theme,
}: {
  body: Record<string, unknown>;
  theme: { fg: string; bg: string };
}) {
  const entries = Object.entries(body);
  const scalars = entries.filter(
    ([, v]) => typeof v !== "object" || v === null,
  );
  const objects = entries.filter(
    ([, v]) => typeof v === "object" && v !== null,
  );
  // Put well-known keys first
  scalars.sort(([a], [b]) => {
    const ai = SCALAR_KEYS_FIRST.indexOf(a);
    const bi = SCALAR_KEYS_FIRST.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return (
    <div
      style={{
        margin: "0 16px 14px 36px",
        borderRadius: "var(--r-s)",
        border: "1px solid var(--line-2)",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      {/* scalar fields as key/value grid */}
      {scalars.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            background: "var(--recess)",
          }}
        >
          {scalars.map(([k, v], i) => (
            <Fragment key={k}>
              <div
                style={{
                  padding: "5px 12px",
                  fontFamily: "var(--font-mono)",
                  color: theme.fg,
                  fontWeight: 600,
                  fontSize: 11,
                  background: i % 2 === 0 ? "rgba(0,0,0,0.06)" : "transparent",
                  borderRight: "1px solid var(--line-2)",
                  whiteSpace: "nowrap",
                }}
              >
                {k}
              </div>
              <div
                style={{
                  padding: "5px 12px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-1)",
                  fontSize: 11,
                  background: i % 2 === 0 ? "rgba(0,0,0,0.06)" : "transparent",
                  wordBreak: "break-all",
                }}
              >
                {String(v)}
              </div>
            </Fragment>
          ))}
        </div>
      )}
      {/* complex fields as collapsible JSON */}
      {objects.map(([k, v]) => (
        <details key={k} style={{ borderTop: "1px solid var(--line-2)" }}>
          <summary
            style={{
              padding: "5px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              color: theme.fg,
              cursor: "pointer",
              background: "var(--recess)",
              listStyle: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ color: "var(--ink-3)", fontSize: 9 }}>▸</span>
            {k}
            {Array.isArray(v) && (
              <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
                [{(v as unknown[]).length}]
              </span>
            )}
          </summary>
          <pre
            style={{
              margin: 0,
              padding: "8px 12px 10px 24px",
              background: "var(--bg-0)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--ink-2)",
            }}
          >
            {JSON.stringify(v, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

const GROUP_ORDER: TraceType[] = [
  "approval",
  "decision",
  "recipe_run",
  "enrichment",
];

type SinceFilter = "1h" | "24h" | "7d" | "30d" | "all";

const SINCE_OPTIONS: { k: SinceFilter; label: string; ms: number | null }[] = [
  { k: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { k: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { k: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { k: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { k: "all", label: "All time", ms: null },
];

export default function TracesPage() {
  const [filter, setFilter] = useState<TraceType | "all">("all");
  const [keyQuery, setKeyQuery] = useState("");
  const [textQuery, setTextQuery] = useState("");
  const [since, setSince] = useState<SinceFilter>("24h");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TraceType>>(
    new Set(),
  );

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("traceType", filter);
    if (keyQuery.trim()) params.set("key", keyQuery.trim());
    if (textQuery.trim()) params.set("q", textQuery.trim());
    const sinceMs = SINCE_OPTIONS.find((o) => o.k === since)?.ms;
    if (sinceMs != null) {
      params.set("since", String(Date.now() - sinceMs));
    }
    params.set("limit", "200");
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [filter, keyQuery, textQuery, since]);

  const { data, error, loading } = useBridgeFetch<TracesResponse>(
    `/api/bridge/traces${qs}`,
    { intervalMs: 3000, transform: validateTraces },
  );

  const traces = data?.traces ?? [];
  const sources = data?.sources;

  const grouped = useMemo(() => {
    const m = new Map<TraceType, DecisionTrace[]>();
    for (const t of traces) {
      const list = m.get(t.traceType) ?? [];
      list.push(t);
      m.set(t.traceType, list);
    }
    return m;
  }, [traces]);

  const toggle = (rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const toggleGroup = (t: TraceType) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const filterChips: { k: TraceType | "all"; label: string }[] = [
    { k: "all", label: "All" },
    { k: "approval", label: "Approval" },
    { k: "decision", label: "Decision" },
    { k: "recipe_run", label: "Recipe run" },
    { k: "enrichment", label: "Enrichment" },
  ];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Traces</h1>
          <div className="page-head-sub">
            Approval history, recipe runs, and enrichment links.
          </div>
        </div>
        <span className="pill muted">
          {traces.length} trace{traces.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* filter bar */}
      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          marginBottom: "var(--s-4)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div className="filter-chips" style={{ marginBottom: 0 }}>
          {filterChips.map((c) => (
            <button
              type="button"
              key={c.k}
              onClick={() => setFilter(c.k)}
              className={`filter-chip${filter === c.k ? " active" : ""}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <select
          value={since}
          onChange={(e) => setSince(e.target.value as SinceFilter)}
          aria-label="Time range"
          style={{
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--recess)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-s)",
            color: "var(--ink-0)",
            cursor: "pointer",
          }}
        >
          {SINCE_OPTIONS.map((o) => (
            <option key={o.k} value={o.k}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={keyQuery}
          onChange={(e) => setKeyQuery(e.target.value)}
          placeholder="filter by key (sessionId, sha, taskId…)"
          style={{
            flex: 1,
            minWidth: 220,
            padding: "6px 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            background: "var(--recess)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-s)",
            color: "var(--ink-0)",
          }}
        />
        <input
          type="text"
          value={textQuery}
          onChange={(e) => setTextQuery(e.target.value)}
          placeholder="search summary + body"
          style={{
            flex: 1,
            minWidth: 220,
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--recess)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-s)",
            color: "var(--ink-0)",
          }}
        />
      </div>

      {sources && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            marginBottom: "var(--s-3)",
            fontSize: 12,
            color: "var(--ink-2)",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "var(--ink-3)" }}>Recording from:</span>
          {(Object.entries(sources) as [TraceType, boolean][]).map(
            ([t, avail]) => (
              <span
                key={t}
                className={`pill ${avail ? TYPE_THEME[t].pill : "muted"}`}
                style={{
                  fontSize: 11,
                  opacity: avail ? 1 : 0.5,
                }}
                title={
                  avail
                    ? `${TYPE_LABELS[t]} traces are being captured`
                    : `${TYPE_LABELS[t]} traces are not being captured yet`
                }
              >
                {TYPE_LABELS[t]}
                {!avail && " (off)"}
              </span>
            ),
          )}
        </div>
      )}

      {error && (
        <div className="alert-err">
          {error.startsWith("/traces")
            ? `Response shape unexpected (bridge version mismatch?): ${error}`
            : `Unreachable: ${error}`}
        </div>
      )}

      {!loading && traces.length === 0 && !error ? (
        <div className="empty-state">
          <h3>
            {filter === "all" && !keyQuery && !textQuery
              ? "No traces yet"
              : "No matching traces"}
          </h3>
          <p>
            {filter === "all" && !keyQuery && !textQuery
              ? "Nothing has been recorded yet. A trace appears here every time the bridge approves an action, links an enrichment, runs a recipe, or an agent saves a decision."
              : `No ${filter === "all" ? "traces" : TYPE_LABELS[filter as TraceType].toLowerCase()} traces${keyQuery ? ` with key matching "${keyQuery}"` : ""}${textQuery ? ` containing "${textQuery}"` : ""}.`}
          </p>
        </div>
      ) : (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}
        >
          {GROUP_ORDER.filter((g) => grouped.has(g)).map((g) => {
            const items = grouped.get(g) ?? [];
            const theme = TYPE_THEME[g];
            const collapsed = collapsedGroups.has(g);
            return (
              <div
                key={g}
                className="card"
                style={{ padding: 0, overflow: "hidden" }}
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(g)}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "12px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--s-3)",
                    borderBottom: collapsed
                      ? "none"
                      : "1px solid var(--line-3)",
                    borderLeft: `3px solid ${theme.fg}`,
                    textAlign: "left",
                    color: "inherit",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      width: 8,
                      textAlign: "center",
                      color: "var(--ink-3)",
                      fontSize: 10,
                    }}
                  >
                    {collapsed ? "▸" : "▾"}
                  </span>
                  <span
                    className={`pill ${theme.pill}`}
                    style={{ fontSize: 10, fontWeight: 600 }}
                  >
                    {TYPE_LABELS[g]}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--ink-0)",
                    }}
                  >
                    {items.length} trace{items.length !== 1 ? "s" : ""}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{ fontSize: 11, color: "var(--ink-3)" }}
                  >
                    latest {relTime(items[0]?.ts ?? Date.now())}
                  </span>
                </button>

                {!collapsed && (
                  <div
                    style={{ display: "flex", flexDirection: "column" }}
                  >
                    {items.map((t) => {
                      const rowKey = `${t.traceType}:${t.ts}:${t.key}`;
                      const isOpen = expanded.has(rowKey);
                      return (
                        <div
                          key={rowKey}
                          style={{
                            borderBottom: "1px solid var(--line-3)",
                          }}
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
                              padding: "9px 16px",
                              cursor: "pointer",
                              textAlign: "left",
                              color: "inherit",
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                width: 8,
                                textAlign: "center",
                                color: "var(--ink-3)",
                                fontSize: 10,
                              }}
                            >
                              {isOpen ? "▾" : "▸"}
                            </span>
                            <span
                              className="mono"
                              style={{
                                fontSize: 11.5,
                                color: theme.fg,
                                flexShrink: 0,
                                fontWeight: 600,
                                minWidth: 140,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={t.key}
                            >
                              {t.key.length > 28
                                ? `${t.key.slice(0, 26)}…`
                                : t.key}
                            </span>
                            <span
                              style={{
                                flex: 1,
                                fontSize: 13,
                                color: "var(--ink-1)",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                minWidth: 0,
                              }}
                            >
                              {t.summary}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--ink-3)",
                                flexShrink: 0,
                              }}
                            >
                              {relTime(t.ts)}
                            </span>
                          </button>
                          {isOpen && (
                            <TraceDetail body={t.body} theme={theme} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
