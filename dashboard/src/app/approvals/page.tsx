"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useApprovalPatterns } from "../../hooks/useApprovalPatterns";
import { apiPath } from "@/lib/api";

interface RiskSignal {
  kind: "destructive_flag" | "domain_reputation" | "path_escape" | "chaining";
  label: string;
  severity: "low" | "medium" | "high";
}

interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  expiresAt?: number;
  riskSignals?: RiskSignal[];
}

type RuleSource = "managed" | "project-local" | "project" | "user";

interface AttributedRule {
  pattern: string;
  source: RuleSource;
}

interface AttributedPermissionRules {
  allow: AttributedRule[];
  ask: AttributedRule[];
  deny: AttributedRule[];
}

interface CcRules {
  allow: string[];
  ask: string[];
  deny: string[];
  workspace: string;
  attributed?: AttributedPermissionRules;
}

type RiskFilter = "all" | "low" | "medium" | "high";

const API = apiPath("/api/bridge");
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Extract the single most important param to show inline above the JSON block.
function primaryParam(
  toolName: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (!params) return null;
  const candidates: Record<string, string[]> = {
    Bash: ["command"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Read: ["file_path", "path"],
    Edit: ["file_path", "path"],
    Write: ["file_path", "path"],
    Glob: ["pattern"],
    Grep: ["pattern"],
  };
  const keys = candidates[toolName] ?? [];
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // fallback: first string value
  for (const v of Object.values(params)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

const SUGGESTION_MIN_APPROVED = 3;

// --- CountdownTimer component ---

function CountdownTimer({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Date.now()),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (remaining === 0) {
    return (
      <span
        className="countdown urgent"
        style={{ color: "var(--err)", fontWeight: 600 }}
        title="Expired"
      >
        Expired
      </span>
    );
  }

  const totalSecs = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const urgent = remaining < 60_000;
  const label =
    mins > 0
      ? `${mins}m ${secs}s remaining`
      : `${secs}s remaining`;

  return (
    <span
      className={`countdown${urgent ? " urgent" : ""}`}
      style={
        urgent
          ? {
              color: "var(--err)",
              animation: "pulse-dot 1s ease-in-out infinite",
            }
          : undefined
      }
      title={`Expires at ${new Date(expiresAt).toLocaleTimeString()}`}
    >
      {label}
    </span>
  );
}

// --- EmptyState component ---

function EmptyState({
  riskFilter,
  onClearFilter,
}: {
  riskFilter: RiskFilter;
  onClearFilter: () => void;
}) {
  const isFiltered = riskFilter !== "all";

  return (
    <div
      className="empty-state"
      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s-3)" }}
    >
      <span
        style={{
          fontSize: 48,
          lineHeight: 1,
          color: "var(--ok)",
          display: "block",
        }}
        aria-hidden="true"
      >
        ✓
      </span>
      <h3 style={{ color: "var(--fg-0)" }}>All caught up!</h3>
      {isFiltered ? (
        <>
          <p>No {riskFilter} risk approvals pending.</p>
          <button
            type="button"
            className="btn sm ghost"
            onClick={onClearFilter}
            style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
          >
            Clear filter
          </button>
        </>
      ) : (
        <p>No pending approvals. All tool calls handled by policy or already decided.</p>
      )}
    </div>
  );
}

// --- Spinner ---

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
        verticalAlign: "middle",
      }}
      aria-hidden="true"
    />
  );
}

// --- ApprovalCard ---

interface ApprovalCardProps {
  p: Pending;
  rules: CcRules | null;
  isExpanded: boolean;
  onToggleExpand: (callId: string) => void;
  onDecide: (callId: string, decision: "approve" | "reject") => Promise<void>;
  isSelected: boolean;
  onToggleSelect: (callId: string) => void;
  fadingOut: boolean;
}

function ApprovalCard({
  p,
  rules,
  isExpanded,
  onToggleExpand,
  onDecide,
  isSelected,
  onToggleSelect,
  fadingOut,
}: ApprovalCardProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const expires = p.expiresAt ?? p.requestedAt + DEFAULT_TTL_MS;
  const primary = primaryParam(p.toolName, p.params);
  const hasParams = p.params && Object.keys(p.params).length > 0;
  const match = matchRule(p.toolName, rules);

  async function handleDecide(decision: "approve" | "reject") {
    setActionError(null);
    if (decision === "approve") setApproving(true);
    else setRejecting(true);
    try {
      await onDecide(p.callId, decision);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setApproving(false);
      setRejecting(false);
    }
  }

  return (
    <article
      className="approval"
      style={{
        opacity: fadingOut ? 0 : 1,
        transform: fadingOut ? "translateY(-4px)" : "translateY(0)",
        transition: "opacity 300ms ease, transform 300ms ease",
      }}
    >
      <div className="approval-head">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(p.callId)}
          aria-label={`Select ${p.toolName} approval`}
          style={{ cursor: "pointer", accentColor: "var(--accent)", flexShrink: 0 }}
        />
        <h3>{p.toolName}</h3>
        <span className={`pill ${tierClass(p.tier)}`}>
          {p.tier} risk
        </span>
        {match && (
          <span className={`pill ${ruleClass(match)}`}>
            CC: {match}
          </span>
        )}
        {p.sessionId && (
          <span
            className="pill muted"
            title={`Session: ${p.sessionId}`}
          >
            session {p.sessionId.slice(0, 8)}
          </span>
        )}
        <span className="approval-spacer" />
        <CountdownTimer expiresAt={expires} />
      </div>

      {p.summary && <p className="approval-summary">{p.summary}</p>}

      {p.riskSignals && p.riskSignals.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginTop: 6,
          }}
        >
          {p.riskSignals.map((s) => (
            <span
              key={`${s.kind}-${s.label}`}
              className={`pill ${s.severity === "high" ? "err" : s.severity === "medium" ? "warn" : "muted"}`}
              title={s.kind}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}

      {primary && (
        <div className="approval-primary">
          <span className="approval-primary-label">
            {primaryLabel(p.toolName)}
          </span>
          <code className="approval-primary-value">{primary}</code>
        </div>
      )}

      {hasParams && (
        <div className="approval-params-wrap">
          <button
            type="button"
            className="approval-params-toggle"
            onClick={() => onToggleExpand(p.callId)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "▾" : "▸"} Full params
            {!isExpanded && p.params && (
              <span className="muted" style={{ marginLeft: 6 }}>
                {Object.keys(p.params).join(", ")}
              </span>
            )}
          </button>
          {isExpanded && (
            <pre className="approval-params-json">
              {safeStringify(p.params)}
            </pre>
          )}
        </div>
      )}

      <div className="approval-actions">
        <button
          type="button"
          className="btn success"
          onClick={() => handleDecide("approve")}
          disabled={approving || rejecting}
          aria-label={`Approve ${p.toolName}`}
        >
          {approving ? <Spinner /> : null}
          {approving ? " Approving…" : "Approve"}
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => handleDecide("reject")}
          disabled={approving || rejecting}
          aria-label={`Reject ${p.toolName}`}
        >
          {rejecting ? <Spinner /> : null}
          {rejecting ? " Rejecting…" : "Reject"}
        </button>
        <Link
          href={`/approvals/${p.callId}`}
          className="btn sm ghost"
          style={{ textDecoration: "none" }}
        >
          Details →
        </Link>
        <span className="approval-spacer" />
        <span className="pill muted" title={p.callId}>
          {p.callId.slice(0, 8)}
        </span>
      </div>

      {actionError && (
        <div
          className="alert-err"
          style={{ marginTop: "var(--s-3)", marginBottom: 0 }}
          role="alert"
        >
          {actionError}
        </div>
      )}
    </article>
  );
}

// --- BatchActionBar ---

function BatchActionBar({
  selectedCount,
  onBatchApprove,
  onBatchReject,
  batchApproving,
  batchRejecting,
}: {
  selectedCount: number;
  onBatchApprove: () => void;
  onBatchReject: () => void;
  batchApproving: boolean;
  batchRejecting: boolean;
}) {
  if (selectedCount === 0) return null;

  return (
    <div
      style={{
        position: "sticky",
        bottom: "var(--s-6)",
        zIndex: 10,
        display: "flex",
        gap: "var(--s-3)",
        alignItems: "center",
        background: "var(--bg-2)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--r-3)",
        padding: "var(--s-3) var(--s-4)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        marginTop: "var(--s-4)",
        animation: "fade-in 200ms ease",
      }}
      role="toolbar"
      aria-label="Batch actions"
    >
      <span style={{ fontSize: 13, color: "var(--fg-1)", fontWeight: 500 }}>
        {selectedCount} selected
      </span>
      <span className="approval-spacer" />
      <button
        type="button"
        className="btn success"
        onClick={onBatchApprove}
        disabled={batchApproving || batchRejecting}
      >
        {batchApproving ? <Spinner /> : null}
        {batchApproving ? " Approving…" : `Approve selected (${selectedCount})`}
      </button>
      <button
        type="button"
        className="btn danger"
        onClick={onBatchReject}
        disabled={batchApproving || batchRejecting}
      >
        {batchRejecting ? <Spinner /> : null}
        {batchRejecting ? " Rejecting…" : `Reject selected (${selectedCount})`}
      </button>
    </div>
  );
}

// --- Page ---

export default function ApprovalsPage() {
  return (
    <Suspense>
      <ApprovalsContent />
    </Suspense>
  );
}

function ApprovalsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionFilter = searchParams.get("session");

  const [pending, setPending] = useState<Pending[]>([]);
  const [rules, setRules] = useState<CcRules | null>(null);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());
  const [batchApproving, setBatchApproving] = useState(false);
  const [batchRejecting, setBatchRejecting] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [ccRulesErr, setCcRulesErr] = useState(false);
  const { patterns, clearPatterns } = useApprovalPatterns();

  useEffect(() => {
    // Load CC permissions once (changes rarely).
    fetch(`${API}/cc-permissions`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setRules(d as CcRules); })
      .catch(() => { setCcRulesErr(true); });
  }, []);

  useEffect(() => {
    const qs = sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : "";
    const streamUrl = apiPath(`/api/bridge/approvals/stream${qs}`);

    let es: EventSource | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let alive = true;

    function applySnapshot(data: string) {
      try {
        setPending(JSON.parse(data) as Pending[]);
        setErr(undefined);
      } catch { /* ignore parse errors */ }
    }

    function startSSE() {
      if (!alive || typeof EventSource === "undefined") return;
      es = new EventSource(streamUrl);
      es.addEventListener("snapshot", (e) => applySnapshot((e as MessageEvent).data));
      es.addEventListener("update", (e) => applySnapshot((e as MessageEvent).data));
      es.addEventListener("bridge-error", () => {
        // Bridge down event from SSE — fall back to polling
        es?.close();
        es = null;
        startPolling();
      });
      es.onerror = () => {
        // SSE unavailable (e.g. old bridge) — fall back to polling
        es?.close();
        es = null;
        startPolling();
      };
    }

    function startPolling() {
      if (pollId !== null || !alive) return;
      const poll = async () => {
        if (!alive) return;
        try {
          const approvalsUrl = `${API}/approvals${sessionFilter ? `?session=${sessionFilter}` : ""}`;
          const r = await fetch(approvalsUrl);
          if (!r.ok) throw new Error(`/approvals ${r.status}`);
          setPending((await r.json()) as Pending[]);
          setErr(undefined);
          // Bridge is back — re-establish SSE and stop polling
          if (pollId !== null) {
            clearInterval(pollId);
            pollId = null;
          }
          startSSE();
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      };
      poll();
      pollId = setInterval(poll, 5000);
    }

    if (typeof EventSource !== "undefined") {
      startSSE();
    } else {
      startPolling();
    }

    return () => {
      alive = false;
      es?.close();
      if (pollId !== null) clearInterval(pollId);
    };
  }, [sessionFilter]);

  // Fade-out then remove
  function removeWithFade(callId: string) {
    setFadingOut((prev) => new Set([...prev, callId]));
    setTimeout(() => {
      setPending((prev) => prev.filter((p) => p.callId !== callId));
      setFadingOut((prev) => {
        const next = new Set(prev);
        next.delete(callId);
        return next;
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(callId);
        return next;
      });
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(callId);
        return next;
      });
    }, 320);
  }

  async function decide(callId: string, decision: "approve" | "reject") {
    const res = await fetch(`${API}/${decision}/${callId}`, { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${decision} failed: ${text || res.status}`);
    }
    removeWithFade(callId);
  }

  function toggleExpand(callId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }

  function toggleSelect(callId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }

  const filtered = pending.filter(
    (p) => riskFilter === "all" || p.tier === riskFilter,
  );

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((p) => selected.has(p.callId));

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of filtered) next.delete(p.callId);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of filtered) next.add(p.callId);
        return next;
      });
    }
  }

  const selectedInView = filtered.filter((p) => selected.has(p.callId));

  async function batchDecide(decision: "approve" | "reject") {
    const ids = selectedInView.map((p) => p.callId);
    if (decision === "approve") setBatchApproving(true);
    else setBatchRejecting(true);
    setBatchErr(null);
    try {
      const failedIds: string[] = [];
      await Promise.all(
        ids.map((id) =>
          fetch(`${API}/${decision}/${id}`, { method: "POST" }).then((res) => {
            if (res.ok) {
              removeWithFade(id);
            } else {
              failedIds.push(id.slice(0, 8));
            }
          }),
        ),
      );
      if (failedIds.length > 0) {
        setBatchErr(`${decision} failed for: ${failedIds.join(", ")}`);
      }
    } finally {
      setBatchApproving(false);
      setBatchRejecting(false);
    }
  }

  const dismissSuggestion = useCallback((toolName: string) => {
    setDismissed((prev) => new Set([...prev, toolName]));
  }, []);

  const copyRule = useCallback((toolName: string) => {
    const snippet = JSON.stringify({ allow: [toolName] }, null, 2);
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(toolName);
      setTimeout(() => setCopied((c) => (c === toolName ? null : c)), 2000);
    });
  }, []);

  const suggestions = [...patterns.entries()].filter(
    ([toolName, p]) =>
      p.approved >= SUGGESTION_MIN_APPROVED &&
      p.rejected === 0 &&
      !dismissed.has(toolName),
  );

  // Count per tier for filter buttons
  const counts: Record<RiskFilter, number> = {
    all: pending.length,
    low: pending.filter((p) => p.tier === "low").length,
    medium: pending.filter((p) => p.tier === "medium").length,
    high: pending.filter((p) => p.tier === "high").length,
  };

  const FILTERS: { label: string; value: RiskFilter }[] = [
    { label: "All", value: "all" },
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
  ];

  return (
    <section>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="page-head-sub">
            Review tool calls before they execute.
          </div>
        </div>
        <span className={`pill ${pending.length > 0 ? "warn" : "ok"}`}>
          {pending.length} pending
        </span>
      </div>

      {/* Hero status bar — counts by tier */}
      <div
        className="card"
        style={{
          padding: "20px 24px",
          marginBottom: "var(--s-4)",
          display: "flex",
          alignItems: "center",
          gap: "var(--s-6)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--ink-2)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 4,
            }}
          >
            Queue
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1.1 }}>
            {pending.length === 0 ? "All clear" : `${pending.length} awaiting decision`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
          {([
            { label: "Total", val: counts.all, color: "var(--ink-0)" },
            { label: "High", val: counts.high, color: "var(--err)" },
            { label: "Medium", val: counts.medium, color: "var(--warn)" },
            { label: "Low", val: counts.low, color: "var(--ink-1)" },
          ] as const).map((s, i) => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
              {i > 0 && (
                <span aria-hidden="true" style={{ width: 1, height: 28, background: "var(--line-2)" }} />
              )}
              <div style={{ textAlign: "center", minWidth: 54 }}>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 800,
                    fontFamily: "var(--font-mono)",
                    color: s.color,
                    lineHeight: 1,
                  }}
                >
                  {s.val}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--ink-2)",
                    marginTop: 4,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {s.label}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Historical approval rate */}
        {(() => {
          let totalApproved = 0;
          let totalRejected = 0;
          for (const p of patterns.values()) {
            totalApproved += p.approved;
            totalRejected += p.rejected;
          }
          const total = totalApproved + totalRejected;
          if (total === 0) return null;
          const approvePct = Math.round((totalApproved / total) * 100);
          const rejectPct = 100 - approvePct;
          return (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                minWidth: 160,
                paddingLeft: "var(--s-4)",
                borderLeft: "1px solid var(--line-2)",
              }}
            >
              <div style={{ fontSize: 10, color: "var(--ink-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Historical rate
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span
                  className="pill ok"
                  style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700 }}
                  title={`${totalApproved} approved`}
                >
                  {approvePct}% approved
                </span>
                <span
                  className="pill err"
                  style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700 }}
                  title={`${totalRejected} rejected`}
                >
                  {rejectPct}% rejected
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  height: 5,
                  borderRadius: 3,
                  overflow: "hidden",
                  background: "var(--recess)",
                  gap: 1,
                }}
                aria-label={`Approval rate: ${approvePct}% approved, ${rejectPct}% rejected`}
              >
                <div style={{ width: `${approvePct}%`, background: "var(--ok)", borderRadius: "3px 0 0 3px" }} />
                {rejectPct > 0 && (
                  <div style={{ flex: 1, background: "var(--err)", borderRadius: "0 3px 3px 0" }} />
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {total} decision{total !== 1 ? "s" : ""} this session
              </div>
            </div>
          );
        })()}
      </div>

      {/* Risk filter buttons */}
      <div className="filter-chips" style={{ marginBottom: "var(--s-4)" }}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`filter-chip${riskFilter === f.value ? " active" : ""}`}
            onClick={() => setRiskFilter(f.value)}
            aria-pressed={riskFilter === f.value}
          >
            {f.label} ({counts[f.value]})
          </button>
        ))}
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {sessionFilter && (
        <div
          className="alert-err"
          style={{
            background: "var(--info-soft)",
            borderColor: "var(--info)",
            color: "var(--info)",
          }}
        >
          Showing approvals for session{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            {sessionFilter.slice(0, 8)}
          </code>
          {" · "}
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "var(--info)",
              cursor: "pointer",
              textDecoration: "underline",
              padding: 0,
              font: "inherit",
              fontSize: "inherit",
            }}
            onClick={() => router.push("/approvals")}
          >
            Clear filter
          </button>
        </div>
      )}

      {filtered.length === 0 && !err ? (
        <EmptyState
          riskFilter={riskFilter}
          onClearFilter={() => setRiskFilter("all")}
        />
      ) : (
        <>
          {/* Select-all header row */}
          {filtered.length > 1 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-3)",
                marginBottom: "var(--s-2)",
                padding: "0 var(--s-2)",
              }}
            >
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAll}
                aria-label="Select all approvals"
                style={{ cursor: "pointer", accentColor: "var(--accent)" }}
              />
              <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
                Select all
              </span>
            </div>
          )}

          <div className="approval-list">
            {filtered.map((p) => (
              <ApprovalCard
                key={p.callId}
                p={p}
                rules={rules}
                isExpanded={expanded.has(p.callId)}
                onToggleExpand={toggleExpand}
                onDecide={decide}
                isSelected={selected.has(p.callId)}
                onToggleSelect={toggleSelect}
                fadingOut={fadingOut.has(p.callId)}
              />
            ))}
          </div>

          <BatchActionBar
            selectedCount={selectedInView.length}
            onBatchApprove={() => batchDecide("approve")}
            onBatchReject={() => batchDecide("reject")}
            batchApproving={batchApproving}
            batchRejecting={batchRejecting}
          />
          {batchErr && (
            <div className="alert-err" role="alert" style={{ marginTop: "var(--s-3)" }}>
              {batchErr}
            </div>
          )}
        </>
      )}

      {suggestions.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-6)" }}>
          <div className="card-head">
            <h2>
              <span aria-hidden="true">💡</span> Pattern suggestions
            </h2>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--fg-2)",
              marginBottom: "var(--s-4)",
            }}
          >
            Tools you&apos;ve consistently approved. Copy a JSON snippet to add
            an allow rule.
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-2)",
            }}
          >
            {suggestions.map(([toolName, p]) => (
              <div
                key={toolName}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  padding: "var(--s-3) var(--s-4)",
                  background: "var(--bg-0)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--r-2)",
                  flexWrap: "wrap",
                }}
              >
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    color: "var(--fg-0)",
                    flex: 1,
                    minWidth: 140,
                  }}
                >
                  {toolName}
                </code>
                <span
                  style={{ fontSize: 13, color: "var(--fg-2)", flexShrink: 0 }}
                >
                  approved {p.approved}&times;
                </span>
                <button
                  type="button"
                  className="btn sm"
                  style={{ flexShrink: 0 }}
                  onClick={() => copyRule(toolName)}
                >
                  {copied === toolName ? "Copied!" : "Copy allow rule"}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={`Dismiss suggestion for ${toolName}`}
                  style={{ flexShrink: 0, padding: "0 var(--s-2)" }}
                  onClick={() => dismissSuggestion(toolName)}
                >
                  &#x2715;
                </button>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: "var(--s-4)",
            }}
          >
            <button
              type="button"
              className="btn sm ghost"
              onClick={clearPatterns}
            >
              Clear all patterns
            </button>
          </div>
        </div>
      )}

      {ccRulesErr && !rules && (
        <div className="card" style={{ marginTop: "var(--s-6)" }}>
          <div className="card-head">
            <h2>CC permission rules</h2>
            <span className="pill warn">Unavailable</span>
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-2)", padding: "var(--s-3) 0" }}>
            Could not load CC permission rules. Bridge may be unreachable.
          </p>
        </div>
      )}
      {rules && (
        <div className="card" style={{ marginTop: "var(--s-6)" }}>
          <div className="card-head">
            <h2>CC permission rules</h2>
            <span className="pill muted">{rules.workspace}</span>
          </div>
          <RuleRow
            label="deny"
            tone="err"
            items={rules.deny ?? []}
            attributed={rules.attributed?.deny}
          />
          <RuleRow
            label="ask"
            tone="warn"
            items={rules.ask ?? []}
            attributed={rules.attributed?.ask}
          />
          <RuleRow
            label="allow"
            tone="ok"
            items={rules.allow ?? []}
            attributed={rules.attributed?.allow}
          />
        </div>
      )}
    </section>
  );
}

function primaryLabel(toolName: string): string {
  const labels: Record<string, string> = {
    Bash: "command",
    WebFetch: "url",
    WebSearch: "query",
    Read: "file",
    Edit: "file",
    Write: "file",
    Glob: "pattern",
    Grep: "pattern",
  };
  return labels[toolName] ?? "value";
}

function sourceBadgeClass(source: RuleSource): string {
  if (source === "managed") return "err";
  if (source === "project-local") return "warn";
  return "muted";
}

function RuleRow({
  label,
  tone,
  items,
  attributed,
}: {
  label: string;
  tone: "ok" | "warn" | "err";
  items: string[];
  attributed?: AttributedRule[];
}) {
  const sourceMap = new Map<string, RuleSource>();
  if (attributed) {
    for (const r of attributed) {
      if (!sourceMap.has(r.pattern)) sourceMap.set(r.pattern, r.source);
    }
  }

  const visible = items.slice(0, 8);
  const overflow = items.length > 8;

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--s-3)",
        padding: "6px 0",
        fontSize: 13,
        alignItems: "baseline",
        flexWrap: "wrap",
      }}
    >
      <span className={`pill ${tone}`} style={{ minWidth: 60, flexShrink: 0 }}>
        {label} · {items.length}
      </span>
      {items.length === 0 ? (
        <span style={{ color: "var(--fg-2)" }}>—</span>
      ) : (
        <span
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--s-2)",
            alignItems: "center",
            flex: 1,
          }}
        >
          {visible.map((pattern) => {
            const src = sourceMap.get(pattern);
            return (
              <span
                key={pattern}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--fg-1)",
                    background: "var(--bg-0)",
                    padding: "1px 5px",
                    borderRadius: "var(--r-1)",
                  }}
                >
                  {pattern}
                </code>
                {src && (
                  <span className={`pill ${sourceBadgeClass(src)}`}>{src}</span>
                )}
              </span>
            );
          })}
          {overflow && (
            <span style={{ color: "var(--fg-3)", fontSize: 12 }}>
              +{items.length - 8} more
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function matchRule(
  toolName: string,
  rules: CcRules | null,
): "deny" | "ask" | "allow" | null {
  if (!rules) return null;
  const match = (list: string[]) =>
    list.some((r) => r === toolName || r.startsWith(`${toolName}(`));
  if (match(rules.deny)) return "deny";
  if (match(rules.ask)) return "ask";
  if (match(rules.allow)) return "allow";
  return null;
}

function ruleClass(kind: "deny" | "ask" | "allow"): string {
  return kind === "deny" ? "err" : kind === "ask" ? "warn" : "ok";
}

function tierClass(t: string): string {
  return t === "high" ? "err" : t === "medium" ? "warn" : "muted";
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
