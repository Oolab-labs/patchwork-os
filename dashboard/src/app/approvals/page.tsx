"use client";
import { useEffect, useState } from "react";

interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  expiresAt?: number;
}

interface CcRules {
  allow: string[];
  ask: string[];
  deny: string[];
  workspace: string;
}

const API = "/api/bridge";
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

export default function ApprovalsPage() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [rules, setRules] = useState<CcRules | null>(null);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  useEffect(() => {
    const tick = async () => {
      try {
        const [pRes, rRes] = await Promise.all([
          fetch(`${API}/approvals`),
          fetch(`${API}/cc-permissions`),
        ]);
        if (!pRes.ok) throw new Error(`/approvals ${pRes.status}`);
        setPending((await pRes.json()) as Pending[]);
        if (rRes.ok) setRules((await rRes.json()) as CcRules);
        setErr(undefined);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function decide(callId: string, decision: "approve" | "reject") {
    await fetch(`${API}/${decision}/${callId}`, { method: "POST" });
    setPending((prev) => prev.filter((p) => p.callId !== callId));
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(callId);
      return next;
    });
  }

  function toggleExpand(callId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="page-head-sub">
            Review and decide on tool calls awaiting human approval.
          </div>
        </div>
        <span className={`pill ${pending.length > 0 ? "warn" : "muted"}`}>
          {pending.length} pending
        </span>
      </div>

      {err && <div className="alert-err">Unreachable: {err}</div>}

      {pending.length === 0 && !err ? (
        <div className="empty-state">
          <h3>Nothing waiting</h3>
          <p>All tool calls have been handled by policy or already decided.</p>
        </div>
      ) : (
        <div className="approval-list">
          {pending.map((p) => {
            const match = matchRule(p.toolName, rules);
            const expires = p.expiresAt ?? p.requestedAt + DEFAULT_TTL_MS;
            const remaining = Math.max(0, expires - Date.now());
            const urgent = remaining < 60_000;
            const primary = primaryParam(p.toolName, p.params);
            const hasParams = p.params && Object.keys(p.params).length > 0;
            const isExpanded = expanded.has(p.callId);

            return (
              <article key={p.callId} className="approval">
                <div className="approval-head">
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
                  <span
                    className={`countdown${urgent ? " urgent" : ""}`}
                    title={`Expires at ${new Date(expires).toLocaleTimeString()}`}
                  >
                    {formatCountdown(remaining)}
                  </span>
                </div>

                {p.summary && <p className="approval-summary">{p.summary}</p>}

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
                      onClick={() => toggleExpand(p.callId)}
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
                    onClick={() => decide(p.callId, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => decide(p.callId, "reject")}
                  >
                    Reject
                  </button>
                  <span className="approval-spacer" />
                  <span className="pill muted" title={p.callId}>
                    {p.callId.slice(0, 8)}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {rules && (
        <div className="card" style={{ marginTop: "var(--s-6)" }}>
          <div className="card-head">
            <h2>CC permission rules</h2>
            <span className="pill muted">{rules.workspace}</span>
          </div>
          <RuleRow label="deny" tone="err" items={rules.deny} />
          <RuleRow label="ask" tone="warn" items={rules.ask} />
          <RuleRow label="allow" tone="ok" items={rules.allow} />
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

function RuleRow({
  label,
  tone,
  items,
}: {
  label: string;
  tone: "ok" | "warn" | "err";
  items: string[];
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--s-3)",
        padding: "6px 0",
        fontSize: 13,
        alignItems: "baseline",
      }}
    >
      <span className={`pill ${tone}`} style={{ minWidth: 60 }}>
        {label} · {items.length}
      </span>
      <span style={{ color: "var(--fg-2)", flex: 1 }}>
        {items.length > 0
          ? `${items.slice(0, 8).join(", ")}${items.length > 8 ? "…" : ""}`
          : "—"}
      </span>
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
  return t === "high" ? "err" : t === "medium" ? "warn" : "ok";
}

function formatCountdown(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}:${rs.toString().padStart(2, "0")}`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
