"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { apiPath } from "@/lib/api";
import { EmptyState, ErrorState, RelationStrip } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";

interface ToolInsight {
  toolName: string;
  approvals: number;
  rejections: number;
  approvalRate: number | null;
  lastDecisionAt: string | null;
  firstDecisionAt: string | null;
  heuristicLabel: string;
  severity: "low" | "medium" | "high";
}

interface InsightsResponse {
  tools: ToolInsight[];
  generatedAt: string;
  totalDecisions: number;
  rejectedToolCount: number;
  trustedToolCount: number;
}

interface RuleExplanation {
  matchedRule: string;
  tier: "deny" | "ask" | "allow";
  source: "managed" | "project-local" | "project" | "user";
}

interface ExplainResponse {
  tool: string;
  specifier: string | null;
  explanation: RuleExplanation | null;
}

const SEVERITY_PILL: Record<ToolInsight["severity"], string> = {
  low: "ok",
  medium: "warn",
  high: "err",
};

// Severity drives a colored pill on each tool row. The "high" tier fires
// whenever a tool has ANY rejection in the window (per
// src/approvalInsights.ts), which is right for surfacing risk — but the
// previous label "rejected" read as "this tool was rejected" even when
// the tool ran with a 97% approval rate. Renamed to "has rejections" so
// the chip describes the signal accurately. Verified by the audit team.
const SEVERITY_LABEL: Record<ToolInsight["severity"], string> = {
  low: "trusted",
  medium: "new",
  high: "has rejections",
};

const TIER_PILL: Record<RuleExplanation["tier"], string> = {
  deny: "err",
  ask: "warn",
  allow: "ok",
};

const SOURCE_LABEL: Record<RuleExplanation["source"], string> = {
  managed: "managed",
  "project-local": "project-local",
  project: "project",
  user: "user",
};

function approvalBar(approvals: number, rejections: number) {
  const total = approvals + rejections;
  if (total === 0) return null;
  const pct = Math.round((approvals / total) * 100);
  return (
    <div
      style={{
        display: "flex",
        height: 6,
        width: 80,
        borderRadius: 3,
        overflow: "hidden",
        background: "var(--bg-3)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          background:
            pct >= 80
              ? "var(--ok)"
              : pct >= 50
                ? "var(--warn, #f59e0b)"
                : "var(--err)",
          transition: "width 0.2s",
        }}
      />
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function RuleCell({ explanation }: { explanation: RuleExplanation | null | undefined }) {
  if (explanation === undefined) {
    return <span style={{ color: "var(--fg-3)", fontSize: "var(--fs-xs)" }}>…</span>;
  }
  if (explanation === null) {
    return <span style={{ color: "var(--fg-3)", fontSize: "var(--fs-xs)" }}>no rule</span>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <code style={{ fontSize: "var(--fs-xs)", color: "var(--fg-1)" }}>{explanation.matchedRule}</code>
      <span className={`pill ${TIER_PILL[explanation.tier]}`} style={{ fontSize: "var(--fs-2xs)" }}>
        {explanation.tier}
      </span>
      <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>
        {SOURCE_LABEL[explanation.source]}
      </span>
    </div>
  );
}

export default function InsightsPage() {
  const { data, error, loading, refetch } = useBridgeFetch<InsightsResponse>(
    "/api/bridge/approval-insights",
    { intervalMs: 30000 },
  );

  const [explanations, setExplanations] = useState<
    Record<string, RuleExplanation | null>
  >({});

  type SortKey = "rejections" | "approvals" | "rate" | "last" | "tool";
  const [sortKey, setSortKey] = useState<SortKey>("rejections");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      // Tool name reads more naturally A→Z by default; numeric columns
      // default to "biggest first" since the actionable signal is at the top.
      setSortDir(k === "tool" ? "asc" : "desc");
    }
  };

  const rawTools = data?.tools ?? [];
  const tools = useMemo(() => {
    const arr = [...rawTools];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case "tool":
          return a.toolName.localeCompare(b.toolName) * dir;
        case "approvals":
          return (a.approvals - b.approvals) * dir;
        case "rejections":
          return (a.rejections - b.rejections) * dir;
        case "rate":
          return ((a.approvalRate ?? -1) - (b.approvalRate ?? -1)) * dir;
        case "last": {
          const ta = a.lastDecisionAt ? Date.parse(a.lastDecisionAt) : 0;
          const tb = b.lastDecisionAt ? Date.parse(b.lastDecisionAt) : 0;
          return (ta - tb) * dir;
        }
      }
    });
    return arr;
  }, [rawTools, sortKey, sortDir]);

  // The "has rejections" severity fires on any rejection — useful, but the
  // err-tone pill screams "broken" for a tool with a 97% approval rate.
  // Drop to warn-tone once approval rate clears the 90% bar.
  function pillToneFor(t: ToolInsight): "ok" | "warn" | "err" {
    if (t.severity !== "high") return SEVERITY_PILL[t.severity] as "ok" | "warn" | "err";
    if (t.approvalRate != null && t.approvalRate >= 0.9) return "warn";
    return "err";
  }

  const sortIndicator = (k: SortKey) =>
    sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  useEffect(() => {
    document.title = "Insights — Patchwork OS";
  }, []);

  useEffect(() => {
    if (tools.length === 0) return;
    // Abort any explain fetches still in flight from a prior generatedAt
    // tick — without this, two waves of requests can race and the older
    // wave's response overwrites the newer wave's explanations.
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/approval-insights/explain-batch"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tools: tools.map((t) => t.toolName) }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const json = (await res.json()) as { explanations: Record<string, RuleExplanation | null> };
        setExplanations((prev) => ({ ...prev, ...json.explanations }));
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // ignore other errors — bridge unreachable
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.generatedAt]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Insights — <span className="accent">how the bridge reads your decisions.</span>
          </h1>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Your personal approval history in aggregate. Same signals shown per-call in the approval modal. Read-only.
          </div>
          <RelationStrip
            items={[
              { label: "Approvals", href: "/approvals", title: "Individual approval calls" },
              { label: "Traces", href: "/traces", title: "Decision traces" },
              { label: "Knowledge", href: "/decisions", title: "Saved decisions" },
              { label: "Suggestions", href: "/suggestions", title: "Patterns mined from runs" },
            ]}
          />
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {data && (
            <>
              <Link
                href="/activity"
                className="pill muted"
                style={{ textDecoration: "none" }}
                title="See activity stream"
              >
                {data.totalDecisions} decisions
              </Link>
              <Link
                href="/approvals?decision=approved"
                className="pill ok"
                style={{ textDecoration: "none" }}
                title="See approved calls"
              >
                {data.trustedToolCount} trusted
              </Link>
              {data.rejectedToolCount > 0 && (
                <Link
                  href="/approvals?decision=rejected"
                  className="pill err"
                  style={{ textDecoration: "none" }}
                  title="See rejected calls"
                >
                  {data.rejectedToolCount} rejected
                </Link>
              )}
            </>
          )}
          <Link href="/insights/replay" className="btn sm">
            Replay →
          </Link>
        </div>
      </div>

      {loading && tools.length === 0 && (
        <SkeletonList rows={6} columns={5} />
      )}
      {error && tools.length === 0 && (
        <ErrorState
          title="Couldn't load insights"
          description="The bridge isn't responding to /approval-insights."
          error={error}
          onRetry={refetch}
        />
      )}
      {error && tools.length > 0 && (
        <div className="alert-err">Refresh failed — {error}</div>
      )}

      {!loading && !error && tools.length === 0 && (
        <EmptyState
          title="No approval history yet"
          description={`Once you start approving or rejecting tool calls in the approval queue, this page will show you your patterns — "you approved this 27 times", "you rejected this tool before", and so on.`}
        />
      )}

      {tools.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Tool history</h2>
            <span className="pill muted">{tools.length}</span>
          </div>
          <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-m)" }}
          >
            <thead>
              <tr
                style={{ borderBottom: "1px solid var(--border-default)" }}
              >
                <th
                  style={{
                    textAlign: "left",
                    padding: "8px 0",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("tool")}
                  aria-sort={sortKey === "tool" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                >
                  Tool{sortIndicator("tool")}
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "8px 8px",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                  }}
                >
                  Heuristic
                </th>
                <th
                  style={{
                    textAlign: "left",
                    padding: "8px 8px",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                  }}
                >
                  Matched rule
                </th>
                <th
                  style={{
                    textAlign: "right",
                    padding: "8px 8px",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("approvals")}
                  aria-sort={sortKey === "approvals" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  title="Approvals"
                >
                  ✓{sortIndicator("approvals")}
                </th>
                <th
                  style={{
                    textAlign: "right",
                    padding: "8px 8px",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("rejections")}
                  aria-sort={sortKey === "rejections" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  title="Rejections"
                >
                  ✗{sortIndicator("rejections")}
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "8px 8px",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("rate")}
                  aria-sort={sortKey === "rate" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                >
                  Rate{sortIndicator("rate")}
                </th>
                <th
                  style={{
                    textAlign: "right",
                    padding: "8px 0",
                    fontWeight: 500,
                    color: "var(--fg-2)",
                    fontSize: "var(--fs-xs)",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort("last")}
                  aria-sort={sortKey === "last" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                >
                  Last{sortIndicator("last")}
                </th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t, i) => (
                <tr
                  // The bridge can return the same toolName more than once
                  // (e.g. a tool exposed under two MCP namespaces, or an
                  // aggregation that double-counts) — keying by toolName
                  // alone then collides ("two children with the same key").
                  // Suffix the index so the key is unique regardless.
                  key={`${t.toolName}-${i}`}
                  style={{ borderBottom: "1px solid var(--border-subtle)" }}
                >
                  <td style={{ padding: "10px 0", verticalAlign: "middle" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        className={`pill ${pillToneFor(t)}`}
                        style={{ fontSize: "var(--fs-2xs)" }}
                      >
                        {SEVERITY_LABEL[t.severity]}
                      </span>
                      <Link
                        href={`/activity?tool=${encodeURIComponent(t.toolName)}`}
                        style={{ color: "inherit", textDecoration: "none" }}
                        title={`View ${t.toolName} activity`}
                      >
                        <code style={{ fontSize: "var(--fs-s)" }}>{t.toolName}</code>
                      </Link>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      color: "var(--fg-2)",
                      verticalAlign: "middle",
                      maxWidth: 260,
                    }}
                  >
                    {t.heuristicLabel}
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      verticalAlign: "middle",
                      maxWidth: 300,
                    }}
                  >
                    <RuleCell explanation={explanations[t.toolName]} />
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      textAlign: "right",
                      color: "var(--ok)",
                      verticalAlign: "middle",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {t.approvals}
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      textAlign: "right",
                      color:
                        t.rejections > 0
                          ? "var(--err)"
                          : "var(--fg-3)",
                      verticalAlign: "middle",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {t.rejections}
                  </td>
                  <td
                    style={{
                      padding: "10px 8px",
                      verticalAlign: "middle",
                      textAlign: "center",
                    }}
                  >
                    {approvalBar(t.approvals, t.rejections)}
                  </td>
                  <td
                    style={{
                      padding: "10px 0",
                      textAlign: "right",
                      color: "var(--fg-3)",
                      verticalAlign: "middle",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {relativeTime(t.lastDecisionAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {data?.generatedAt && (
        <p
          style={{
            fontSize: "var(--fs-xs)",
            color: "var(--fg-2)",
            marginTop: "var(--s-5)",
          }}
        >
          Generated at {new Date(data.generatedAt).toLocaleTimeString()}.
          Signals computed from your local activity log — nothing leaves your
          machine.
        </p>
      )}
    </section>
  );
}
