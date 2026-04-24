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

function DecisionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tag, setTag] = useState(searchParams.get("tag") ?? "");
  const [keyQuery, setKeyQuery] = useState(searchParams.get("ref") ?? "");
  const [textQuery, setTextQuery] = useState(searchParams.get("q") ?? "");

  // Mirror filter state to the URL so links are shareable and the back
  // button reopens the same view. replaceState (not push) — filters are
  // transient within one page, no need to pollute history.
  useEffect(() => {
    const params = new URLSearchParams();
    if (tag.trim()) params.set("tag", tag.trim());
    if (keyQuery.trim()) params.set("ref", keyQuery.trim());
    if (textQuery.trim()) params.set("q", textQuery.trim());
    const qs = params.toString();
    router.replace(qs ? `/decisions?${qs}` : "/decisions", { scroll: false });
  }, [tag, keyQuery, textQuery, router]);

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    params.set("traceType", "decision");
    if (tag.trim()) params.set("tag", tag.trim());
    if (keyQuery.trim()) params.set("key", keyQuery.trim());
    if (textQuery.trim()) params.set("q", textQuery.trim());
    params.set("limit", "200");
    return `?${params.toString()}`;
  }, [tag, keyQuery, textQuery]);

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

      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          marginBottom: "var(--s-3)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="filter by tag"
          style={{
            minWidth: 200,
            padding: "6px 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            background: "var(--bg-2)",
            border: "1px solid var(--bg-3)",
            borderRadius: 4,
            color: "var(--fg-0)",
          }}
        />
        <input
          type="text"
          value={keyQuery}
          onChange={(e) => setKeyQuery(e.target.value)}
          placeholder="filter by ref (#42, sha, etc.)"
          style={{
            flex: 1,
            minWidth: 200,
            padding: "6px 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            background: "var(--bg-2)",
            border: "1px solid var(--bg-3)",
            borderRadius: 4,
            color: "var(--fg-0)",
          }}
        />
        <input
          type="text"
          value={textQuery}
          onChange={(e) => setTextQuery(e.target.value)}
          placeholder="search problem + solution"
          style={{
            flex: 1,
            minWidth: 200,
            padding: "6px 10px",
            fontSize: 13,
            background: "var(--bg-2)",
            border: "1px solid var(--bg-3)",
            borderRadius: 4,
            color: "var(--fg-0)",
          }}
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
              ? "Agents save decisions via ctxSaveTrace when they resolve a task. Those entries will appear here and in the session-start digest."
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
            return (
              <div
                key={rowKey}
                className="card"
                style={{ padding: "var(--s-3)" }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "var(--s-3)",
                    marginBottom: b.problem || b.solution ? 8 : 0,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 13,
                      color: "#a78bfa",
                      flexShrink: 0,
                    }}
                  >
                    {b.ref ?? t.key}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "flex-end",
                      gap: "var(--s-2)",
                      color: "var(--fg-3)",
                      fontSize: 12,
                    }}
                  >
                    {typeof b.sessionId === "string" && b.sessionId.length > 0 && (
                      <Link
                        href={`/sessions/${b.sessionId}`}
                        className="pill muted"
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          textDecoration: "none",
                        }}
                        title={`session ${b.sessionId}`}
                      >
                        {b.sessionId.slice(0, 8)}
                      </Link>
                    )}
                    <span>{relTime(t.ts)}</span>
                  </div>
                </div>
                {b.problem && (
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--fg-2)",
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ color: "var(--fg-3)" }}>Problem:</span>{" "}
                    {b.problem}
                  </div>
                )}
                {b.solution && (
                  <div style={{ fontSize: 13, color: "var(--fg-1)" }}>
                    <span style={{ color: "var(--fg-3)" }}>Solution:</span>{" "}
                    {b.solution}
                  </div>
                )}
                {tags.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      marginTop: 8,
                    }}
                  >
                    {tags.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTag(t)}
                        className="pill muted"
                        style={{
                          cursor: "pointer",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                        }}
                      >
                        {t}
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
