"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiPath } from '@/lib/api';
import { relTime } from "@/components/time";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface RiskSignal {
  kind: string;
  label: string;
  severity: "low" | "medium" | "high";
}

interface PersonalSignal {
  kind: string;
  label: string;
  severity: "low" | "medium" | "high";
  source:
    | "approval_history"
    | "activity_history"
    | "tool_registry"
    | "recipe_run_log";
  count?: number;
}

interface PendingRecord {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  expiresAt?: number;
  riskSignals?: RiskSignal[];
  personalSignals?: PersonalSignal[];
}

interface DecisionRecord {
  id: number;
  timestamp: string;
  event: string;
  metadata?: {
    callId?: string;
    toolName?: string;
    specifier?: string;
    decision?: string;
    reason?: string;
    permissionMode?: string;
    sessionId?: string;
    summary?: string;
    riskSignals?: RiskSignal[];
  };
}

interface NearbyTool {
  kind: "tool";
  id: number;
  timestamp: string;
  tool: string;
  durationMs: number;
  status: "success" | "error";
  errorMessage?: string;
}

interface NearbyLifecycle {
  kind: "lifecycle";
  id: number;
  timestamp: string;
  event: string;
  metadata?: Record<string, unknown>;
}

type NearbyEntry = NearbyTool | NearbyLifecycle;

interface DetailResponse {
  pending: PendingRecord | null;
  decision: DecisionRecord | null;
  nearby: NearbyEntry[];
}

interface BridgeStatus {
  patchwork?: {
    approvalGate?: string;
  };
}

type GateMode = "off" | "high" | "all";
type Tier = "low" | "medium" | "high";

/**
 * Explain *why* a given call hit the delegation policy. Pure derivation from
 * (active mode, tool tier) — the same logic that approvalHttp uses to decide
 * whether to gate. Surfacing this on the detail page is the "show your work"
 * UX from strategic plan §2.
 */
function explainMatch(
  mode: GateMode,
  tier: Tier | undefined,
): { matched: boolean; rule: string; mode: GateMode } {
  if (mode === "off") {
    return {
      matched: false,
      mode,
      rule: "Policy is off — calls are not gated. This entry exists from a previous setting or an explicit ask.",
    };
  }
  if (mode === "all") {
    return {
      matched: true,
      mode,
      rule: "Policy is all — every tool call requires approval, regardless of risk tier.",
    };
  }
  // mode === "high"
  if (tier === "high") {
    return {
      matched: true,
      mode,
      rule: "Policy is high and this tool is tier high — high-risk calls require approval.",
    };
  }
  return {
    matched: false,
    mode,
    rule: `Policy is high but this tool is tier ${tier ?? "unknown"} — would normally pass through. Gated for another reason (recipe step trust, signal escalation, or manual ask).`,
  };
}

export default function ApprovalDetailPage() {
  const params = useParams<{ callId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const callId = params.callId;
  const approvalToken = search.get("approvalToken") ?? undefined;
  const [decideErr, setDecideErr] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);

  // Stop polling once a decision arrives — page is in a terminal state.
  // We need the most recent value to gate the hook, so we read it via a
  // separate ref-like state rather than letting `useBridgeFetch` run forever.
  const [hasDecision, setHasDecision] = useState(false);
  const { data, error, loading, status } = useBridgeFetch<DetailResponse>(
    `/api/bridge/approvals/${callId}`,
    { intervalMs: 2000, enabled: !hasDecision },
  );
  useEffect(() => {
    if (data?.decision) setHasDecision(true);
  }, [data?.decision]);
  const { data: bridgeStatus } = useBridgeFetch<BridgeStatus>(
    "/api/bridge/status",
    { intervalMs: 5000 },
  );

  async function decide(choice: "approve" | "reject") {
    if (deciding) return;
    setDecideErr(null);
    setDeciding(choice);
    try {
      const headers: Record<string, string> = {};
      if (approvalToken) {
        headers.Authorization = `Bearer ${approvalToken}`;
      }
      const res = await fetch(apiPath(`/api/bridge/${choice}/${callId}`), {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {}
        setDecideErr(
          `${choice} failed: ${res.status}${detail ? ` — ${detail}` : ""}`,
        );
        return;
      }
      router.push("/approvals");
    } catch (e) {
      setDecideErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding(null);
    }
  }

  const pending = data?.pending ?? null;
  const decision = data?.decision ?? null;
  const meta = decision?.metadata ?? {};

  const rawGate = bridgeStatus?.patchwork?.approvalGate;
  const gateMode: GateMode =
    rawGate === "high" || rawGate === "all" ? rawGate : "off";
  const effectiveTier = (pending?.tier ?? undefined) as Tier | undefined;
  // Render the policy card whenever bridge status is known. Even on
  // "Unknown callId" the user benefits from seeing their active mode —
  // it answers "is anything being gated right now at all?"
  const showPolicyCard = bridgeStatus !== null && bridgeStatus !== undefined;
  const match = showPolicyCard
    ? explainMatch(gateMode, effectiveTier)
    : null;

  // Header state — prefer pending, then decision, then fall back.
  const toolName = pending?.toolName ?? meta.toolName ?? "Unknown";
  const tier = pending?.tier;
  const decisionKind = meta.decision;
  const sessionId = pending?.sessionId ?? meta.sessionId;

  return (
    <section>
      <div className="page-head">
        <div>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            <Link href="/approvals" style={{ color: "var(--fg-2)" }}>
              ← Approvals
            </Link>
          </div>
          <h1>{toolName}</h1>
          <div className="page-head-sub">
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {callId}
            </code>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {pending && (
            <span className="pill warn" title="Awaiting human decision">
              pending
            </span>
          )}
          {tier && (
            <span className={`pill ${tierClass(tier)}`}>{tier} risk</span>
          )}
          {decisionKind && (
            <span
              className={`pill ${decisionKind === "allow" ? "ok" : "err"}`}
            >
              {decisionKind}
            </span>
          )}
        </div>
      </div>

      {decideErr && <div className="alert-err">{decideErr}</div>}
      {error && !data && (
        <div className="alert-err">Unreachable: {error}</div>
      )}
      {!loading && !data && status === 404 && (
        <div className="empty-state">
          <h3>Unknown callId</h3>
          <p>
            This approval isn&apos;t pending and hasn&apos;t been decided yet.
            It may have expired, or the ID is wrong.
          </p>
        </div>
      )}

      {match && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Delegation policy</h2>
            <span
              className={`pill ${match.mode === "off" ? "muted" : match.mode === "all" ? "err" : "warn"}`}
              title="Active delegation policy mode"
            >
              mode: {match.mode}
            </span>
          </div>
          <Row label="Active mode" value={match.mode} mono />
          {effectiveTier && (
            <Row label="Risk tier" value={effectiveTier} mono />
          )}
          <Row
            label="Matched rule"
            value={match.matched ? "yes" : "no"}
            mono
          />
          <p
            style={{
              fontSize: 13,
              color: "var(--fg-1)",
              marginTop: 10,
              lineHeight: 1.5,
            }}
          >
            {match.rule}
          </p>
        </div>
      )}

      {pending && (
        <div
          className="card"
          style={{
            marginTop: "var(--s-4)",
            padding: "20px 24px",
            borderLeft: `3px solid ${
              tier === "high" ? "var(--err)" : tier === "medium" ? "var(--warn)" : "var(--ok)"
            }`,
          }}
        >
          <div className="card-head">
            <h2>Decide</h2>
            <span className="pill warn" style={{ fontSize: 11 }}>
              <span className="pill-dot" /> awaiting you
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: "var(--s-3)" }}>
            Still in the queue. Approve or reject to unblock the caller.
          </p>
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn success"
              onClick={() => decide("approve")}
              disabled={deciding !== null}
              aria-busy={deciding === "approve"}
            >
              {deciding === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => decide("reject")}
              disabled={deciding !== null}
              aria-busy={deciding === "reject"}
            >
              {deciding === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <span className="approval-spacer" />
            <Link href="/approvals" className="btn sm ghost" style={{ textDecoration: "none" }}>
              ← Back to queue
            </Link>
          </div>
        </div>
      )}

      {decision && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Decision</h2>
            <span className="pill muted" title={decision.timestamp}>
              {relTime(Date.parse(decision.timestamp))}
            </span>
          </div>
          <Row label="Decision" value={meta.decision ?? "—"} />
          <Row label="Reason" value={meta.reason ?? "—"} mono />
          {meta.specifier && (
            <Row label="Specifier" value={meta.specifier} mono />
          )}
          {meta.permissionMode && (
            <Row label="Permission mode" value={meta.permissionMode} mono />
          )}
          {meta.summary && <Row label="Summary" value={meta.summary} />}
        </div>
      )}

      {(pending?.riskSignals?.length || meta.riskSignals?.length) && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Risk signals</h2>
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            {(pending?.riskSignals ?? meta.riskSignals ?? []).map((s) => (
              <span
                key={`${s.kind}-${s.label}`}
                className={`pill ${s.severity === "high" ? "err" : s.severity === "medium" ? "warn" : "muted"}`}
                title={s.kind}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {pending?.personalSignals && pending.personalSignals.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Your history with this call</h2>
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            {pending.personalSignals.map((s) => (
              <span
                key={`personal-${s.kind}-${s.label}`}
                className={`pill ${s.severity === "high" ? "err" : s.severity === "medium" ? "warn" : "muted"}`}
                title={`${s.kind} (from ${s.source})`}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {sessionId && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Session</h2>
          </div>
          <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {sessionId}
            </code>
            <Link
              href={`/approvals?session=${sessionId}`}
              style={{ fontSize: 13, color: "var(--accent)" }}
            >
              All approvals for this session →
            </Link>
          </div>
        </div>
      )}

      {pending?.params && Object.keys(pending.params).length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Parameters</h2>
          </div>
          <pre className="approval-params-json">
            {JSON.stringify(pending.params, null, 2)}
          </pre>
        </div>
      )}

      {data?.nearby && data.nearby.length > 0 && (
        <div className="card" style={{ marginTop: "var(--s-4)" }}>
          <div className="card-head">
            <h2>Nearby activity</h2>
            <span className="pill muted">±60s · {data.nearby.length}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Time</th>
                  <th style={{ width: 110 }}>Kind</th>
                  <th>Tool / Event</th>
                  <th style={{ width: 110 }}>Duration</th>
                  <th style={{ width: 110 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.nearby.map((e) => (
                  <tr key={`${e.kind}-${e.id}`}>
                    <td className="muted" title={e.timestamp}>
                      {relTime(Date.parse(e.timestamp))}
                    </td>
                    <td>
                      <span
                        className={`pill ${
                          e.kind === "tool" && e.status === "error"
                            ? "err"
                            : "muted"
                        }`}
                      >
                        {e.kind === "tool" ? "tool" : e.event}
                      </span>
                    </td>
                    <td className="mono">
                      {e.kind === "tool" ? e.tool : "—"}
                    </td>
                    <td className="mono muted">
                      {e.kind === "tool" ? `${e.durationMs}ms` : "—"}
                    </td>
                    <td>
                      {e.kind === "tool" ? (
                        <span
                          className={`status-cell ${e.status === "error" ? "err" : "ok"}`}
                        >
                          <span className="pill-dot" />
                          {e.status}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{ color: "var(--fg-0)", textAlign: "right" }}
      >
        {value}
      </span>
    </div>
  );
}

function tierClass(t: string): string {
  return t === "high" ? "err" : t === "medium" ? "warn" : "ok";
}
