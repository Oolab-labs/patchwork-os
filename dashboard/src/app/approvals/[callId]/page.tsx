"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
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

export default function ApprovalDetailPage() {
  const params = useParams<{ callId: string }>();
  const router = useRouter();
  const callId = params.callId;
  const [decideErr, setDecideErr] = useState<string | null>(null);

  const { data, error, loading, status } = useBridgeFetch<DetailResponse>(
    `/api/bridge/approvals/${callId}`,
    { intervalMs: 2000 },
  );

  async function decide(choice: "approve" | "reject") {
    setDecideErr(null);
    try {
      const res = await fetch(apiPath(`/api/bridge/${choice}/${callId}`), {
        method: "POST",
      });
      if (!res.ok) {
        setDecideErr(`${choice} failed: ${res.status}`);
        return;
      }
      router.push("/approvals");
    } catch (e) {
      setDecideErr(e instanceof Error ? e.message : String(e));
    }
  }

  const pending = data?.pending ?? null;
  const decision = data?.decision ?? null;
  const meta = decision?.metadata ?? {};

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
            >
              Approve
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => decide("reject")}
            >
              Reject
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
