"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { arr, isRecord, shape, type ShapeCheck } from "@/lib/validate";

interface DecisionTrace {
  traceType: "decision";
  ts: number;
  key: string;
  summary: string;
  body: {
    ref?: string;
    problem?: string;
    solution?: string;
    workspace?: string;
    sessionId?: string;
    tags?: string[];
    [k: string]: unknown;
  };
}

interface TracesResponse {
  traces: DecisionTrace[];
  count: number;
  sources: { decision: boolean };
}

const validateTraces: ShapeCheck<TracesResponse> = shape(
  "/traces?traceType=decision",
  (raw, errors) => {
    if (!isRecord(raw)) {
      errors.push({ path: "$", reason: "expected object" });
      return null;
    }
    arr(raw, "traces", errors);
    if (errors.length > 0) return null;
    return raw as unknown as TracesResponse;
  },
);

export default function DecisionsPage() {
  return (
    <Suspense>
      <DecisionsContent />
    </Suspense>
  );
}

type SinceFilter = "1h" | "24h" | "7d" | "30d" | "all";

const SINCE_OPTIONS: { k: SinceFilter; label: string; ms: number | null }[] = [
  { k: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { k: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { k: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { k: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { k: "all", label: "All time", ms: null },
];

function isSinceFilter(v: string | null): v is SinceFilter {
  return v === "1h" || v === "24h" || v === "7d" || v === "30d" || v === "all";
}

function DecisionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tag, setTag] = useState(searchParams.get("tag") ?? "");
  const [keyQuery, setKeyQuery] = useState(searchParams.get("ref") ?? "");
  const [textQuery, setTextQuery] = useState(searchParams.get("q") ?? "");
  const [since, setSince] = useState<SinceFilter>(() => {
    const sp = searchParams.get("since");
    return isSinceFilter(sp) ? sp : "30d";
  });

  // Mirror filter state to the URL so links are shareable and the back
  // button reopens the same view. replaceState (not push) — filters are
  // transient within one page, no need to pollute history.
  useEffect(() => {
    const params = new URLSearchParams();
    if (tag.trim()) params.set("tag", tag.trim());
    if (keyQuery.trim()) params.set("ref", keyQuery.trim());
    if (textQuery.trim()) params.set("q", textQuery.trim());
    if (since !== "30d") params.set("since", since);
    const qs = params.toString();
    router.replace(qs ? `/decisions?${qs}` : "/decisions", { scroll: false });
  }, [tag, keyQuery, textQuery, since, router]);

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    params.set("traceType", "decision");
    if (tag.trim()) params.set("tag", tag.trim());
    if (keyQuery.trim()) params.set("key", keyQuery.trim());
    if (textQuery.trim()) params.set("q", textQuery.trim());
    const sinceMs = SINCE_OPTIONS.find((o) => o.k === since)?.ms;
    if (sinceMs != null) {
      params.set("since", String(Date.now() - sinceMs));
    }
    params.set("limit", "200");
    return `?${params.toString()}`;
  }, [tag, keyQuery, textQuery, since]);

  const { data, error, loading } = useBridgeFetch<TracesResponse>(
    `/api/bridge/traces${qs}`,
    { intervalMs: 5000, transform: validateTraces },
  );

  const traces = data?.traces ?? [];

  // Collect tag universe from the current result set for click-to-filter pills.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of traces) {
      if (Array.isArray(t.body.tags)) {
        for (const tag of t.body.tags) {
          if (typeof tag === "string") set.add(tag);
        }
      }
    }
    return [...set].sort();
  }, [traces]);

  // Classify a decision into an accent variant based on tag/ref hints.
  const variantFor = (t: DecisionTrace): "accent" | "info" | "warn" | "err" => {
    const tags = (Array.isArray(t.body.tags) ? t.body.tags : []).map((x) => String(x).toLowerCase());
    const ref = String(t.body.ref ?? t.key ?? "").toLowerCase();
    if (tags.some((x) => /(bug|error|fail|incident|regress)/.test(x))) return "err";
    if (tags.some((x) => /(warn|risk|flaky|security)/.test(x))) return "warn";
    if (tags.some((x) => /(feat|feature|ship|release)/.test(x)) || ref.startsWith("pr-")) return "accent";
    return "info";
  };

  const variantCounts = useMemo(() => {
    const c = { accent: 0, info: 0, warn: 0, err: 0 };
    for (const t of traces) c[variantFor(t)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traces]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Decisions</h1>
          <div className="page-head-sub">
            Knowledge saved by agents across sessions.
          </div>
        </div>
        <span className="pill muted">
          {traces.length} decision{traces.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Sub-header: counts per variant */}
      {traces.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "var(--s-2)",
            marginBottom: "var(--s-3)",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-3)", marginRight: 4 }}>
            Grouped by kind:
          </span>
          <span
            className="pill"
            style={{ fontSize: 11, borderLeft: "3px solid var(--orange)" }}
            title="Feature work and shipped releases"
          >
            Feature &middot; {variantCounts.accent}
          </span>
          <span className="pill info" style={{ fontSize: 11 }} title="General notes and context">
            General &middot; {variantCounts.info}
          </span>
          <span className="pill warn" style={{ fontSize: 11 }} title="Risks, flaky tests, security concerns">
            Risk &middot; {variantCounts.warn}
          </span>
          <span className="pill err" style={{ fontSize: 11 }} title="Bugs, incidents, regressions">
            Bug &middot; {variantCounts.err}
          </span>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          marginBottom: "var(--s-3)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
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
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="filter by tag"
          className="input"
          style={{ minWidth: 160, fontFamily: "var(--font-mono)" }}
        />
        <input
          type="text"
          value={keyQuery}
          onChange={(e) => setKeyQuery(e.target.value)}
          placeholder="filter by ref (#42, sha, etc.)"
          className="input"
          style={{ flex: 1, minWidth: 200, fontFamily: "var(--font-mono)" }}
        />
        <input
          type="text"
          value={textQuery}
          onChange={(e) => setTextQuery(e.target.value)}
          placeholder="search problem + solution"
          className="input"
          style={{ flex: 1, minWidth: 200 }}
        />
      </div>

      {allTags.length > 0 && !tag && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: "var(--s-3)",
            fontSize: 12,
            color: "var(--fg-3)",
            alignItems: "center",
          }}
        >
          <span>tags:</span>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTag(t)}
              className="pill muted"
              style={{ cursor: "pointer", fontFamily: "var(--font-mono)" }}
            >
              {t}
            </button>
          ))}
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
            {!tag && !keyQuery && !textQuery
              ? "No decisions yet"
              : "No matching decisions"}
          </h3>
          <p>
            {!tag && !keyQuery && !textQuery
              ? "When an agent resolves a task it can save a short problem/solution note here. New decisions also show up in the next session's start-of-task digest, so the next agent starts with the context."
              : `No decisions${tag ? ` tagged "${tag}"` : ""}${keyQuery ? ` with ref matching "${keyQuery}"` : ""}${textQuery ? ` containing "${textQuery}"` : ""}.`}
          </p>
          {(tag || keyQuery || textQuery) && (
            <button
              type="button"
              onClick={() => {
                setTag("");
                setKeyQuery("");
                setTextQuery("");
              }}
              className="pill muted"
              style={{ cursor: "pointer", marginTop: "var(--s-3)" }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}
        >
          {traces.map((t) => {
            const b = t.body;
            const tags = Array.isArray(b.tags) ? b.tags : [];
            const rowKey = `${t.ts}:${t.key}`;
            const variant = variantFor(t);
            return (
              <div
                key={rowKey}
                className={`decision-row decision-row-${variant}`}
                style={{ padding: "12px 16px", cursor: "default", display: "flex", flexDirection: "column", gap: 0 }}
              >
                {/* header row: ref + meta */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--s-3)",
                    marginBottom: (b.problem || b.solution) ? 10 : 0,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--purple)",
                      flexShrink: 0,
                    }}
                  >
                    {b.ref ?? t.key}
                  </span>
                  <span style={{ flex: 1 }} />
                  {typeof b.sessionId === "string" && b.sessionId.length > 0 && (
                    <Link
                      href={`/sessions/${b.sessionId}`}
                      className="pill muted"
                      style={{ fontFamily: "var(--font-mono)", fontSize: 10, textDecoration: "none" }}
                      title={`session ${b.sessionId}`}
                    >
                      {b.sessionId.slice(0, 8)}
                    </Link>
                  )}
                  <span style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>
                    {relTime(t.ts)}
                  </span>
                </div>

                {/* two-column body: problem | solution */}
                {(b.problem || b.solution) && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 12,
                    }}
                  >
                    {b.problem && (
                      <div
                        style={{
                          padding: "8px 12px",
                          background: "var(--recess)",
                          borderRadius: "var(--r-s)",
                          borderTop: "2px solid var(--amber)",
                        }}
                      >
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", letterSpacing: "0.06em", marginBottom: 5, textTransform: "uppercase" }}>
                          Problem
                        </div>
                        <div style={{ fontSize: 13, color: "var(--ink-1)", lineHeight: 1.55 }}>
                          {b.problem as string}
                        </div>
                      </div>
                    )}
                    {b.solution && (
                      <div
                        style={{
                          padding: "8px 12px",
                          background: "var(--recess)",
                          borderRadius: "var(--r-s)",
                          borderTop: "2px solid var(--green)",
                        }}
                      >
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--green)", letterSpacing: "0.06em", marginBottom: 5, textTransform: "uppercase" }}>
                          Solution
                        </div>
                        <div style={{ fontSize: 13, color: "var(--ink-0)", lineHeight: 1.55 }}>
                          {b.solution as string}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* tags */}
                {tags.length > 0 && (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 10 }}>
                    {tags.map((tg) => (
                      <button
                        key={tg}
                        type="button"
                        onClick={() => setTag(tg)}
                        className="tag-pill"
                        style={{ cursor: "pointer", fontFamily: "var(--font-mono)" }}
                      >
                        {tg}
                      </button>
                    ))}
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
