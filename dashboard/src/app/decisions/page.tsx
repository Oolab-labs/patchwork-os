"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { arr, isRecord, shape, type ShapeCheck } from "@/lib/validate";
import { DecisionsTabs } from "@/components/DecisionsTabs";
import { ErrorState, LivePill } from "@/components/patchwork";

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
  // Stabilise the array reference: only return a fresh array when the set of
  // tags actually changes. The page polls every 5s and creates a new traces
  // array each tick — without this, the pill row remounts on every poll and
  // briefly flickers.
  const tagsRef = useRef<string[]>([]);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of traces) {
      if (Array.isArray(t.body.tags)) {
        for (const tag of t.body.tags) {
          if (typeof tag === "string") set.add(tag);
        }
      }
    }
    const next = [...set].sort();
    const prev = tagsRef.current;
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) {
      return prev;
    }
    tagsRef.current = next;
    return next;
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

  return (
    <section>
      <DecisionsTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Decisions — <span className="accent">the knowledge base your agents wrote.</span>
          </h1>
          <div className="editorial-sub" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>{traces.length} trace{traces.length !== 1 ? "s" : ""} · ctxSaveTrace persists · ctxQueryTraces recalls</span>
            <LivePill label="5s" tone="muted" />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="visually-hidden" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
              Search decisions
            </span>
            <input
              type="text"
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              placeholder="Search problems & solutions…"
              className="input"
              aria-label="Search decisions"
              style={{ minWidth: 240, width: 280 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <input
              type="text"
              value={keyQuery}
              onChange={(e) => setKeyQuery(e.target.value)}
              placeholder="Filter by ref (e.g. PR-42)"
              className="input"
              aria-label="Filter by ref"
              style={{ minWidth: 160, width: 180, fontFamily: "var(--font-mono)" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <select
              value={since}
              onChange={(e) => setSince(e.target.value as SinceFilter)}
              className="input"
              aria-label="Time window"
              style={{ width: "auto", cursor: "pointer" }}
            >
              {SINCE_OPTIONS.map((o) => (
                <option key={o.k} value={o.k}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {allTags.length > 0 && (
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
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)" }}>
            Tags
          </span>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTag(tag === t ? "" : t)}
              aria-pressed={tag === t}
              aria-label={`Filter by tag: ${t}`}
              className={tag === t ? "pill accent" : "pill muted"}
              style={{ cursor: "pointer", fontFamily: "var(--font-mono)" }}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {loading && traces.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}

      {error && traces.length === 0 && (
        <ErrorState
          title={error.startsWith("/traces") ? "Bridge version mismatch" : "Couldn't load decisions"}
          description={
            error.startsWith("/traces")
              ? "The /traces response didn't match the schema this dashboard expects."
              : "The bridge isn't responding. Decisions will reload on the next tick."
          }
          error={error}
          onRetry={() => window.location.reload()}
        />
      )}
      {error && traces.length > 0 && (
        <div className="alert-err">Refresh failed — {error}</div>
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
                setSince("30d");
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
                    className={`chip chip-${
                      variant === "err" ? "red" : variant === "warn" ? "amber" : variant === "info" ? "blue" : "accent"
                    }`}
                    style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-mono)", fontSize: 10 }}
                  >
                    {variant === "err" ? "bug" : variant === "warn" ? "risk" : variant === "info" ? "decision" : "feature"}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--ink-1)",
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
                          padding: "10px 14px",
                          background: "var(--orange-soft)",
                          borderRadius: "var(--r-s)",
                          border: "1px solid var(--orange-tint)",
                        }}
                      >
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--orange)", letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>
                          ✻ Problem
                        </div>
                        <div style={{ fontSize: 13, color: "var(--ink-1)", lineHeight: 1.55 }}>
                          {b.problem as string}
                        </div>
                      </div>
                    )}
                    {b.solution && (
                      <div
                        style={{
                          padding: "10px 14px",
                          background: "var(--green-soft)",
                          borderRadius: "var(--r-s)",
                          border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)",
                        }}
                      >
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--green)", letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>
                          ✻ Solution
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
