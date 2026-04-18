"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useApprovalPatterns } from "../../hooks/useApprovalPatterns";

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

const SUGGESTION_MIN_APPROVED = 3;

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
  const [, setTick] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const { patterns, clearPatterns } = useApprovalPatterns();

  useEffect(() => {
    const tick = async () => {
      try {
        const approvalsUrl = `${API}/approvals${sessionFilter ? `?session=${sessionFilter}` : ""}`;
        const [pRes, rRes] = await Promise.all([
          fetch(approvalsUrl),
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
  }, [sessionFilter]);

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
              </article>
            );
          })}
        </div>
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

      {rules && (
        <div className="card" style={{ marginTop: "var(--s-6)" }}>
          <div className="card-head">
            <h2>CC permission rules</h2>
            <span className="pill muted">{rules.workspace}</span>
          </div>
          <RuleRow
            label="deny"
            tone="err"
            items={rules.deny}
            attributed={rules.attributed?.deny}
          />
          <RuleRow
            label="ask"
            tone="warn"
            items={rules.ask}
            attributed={rules.attributed?.ask}
          />
          <RuleRow
            label="allow"
            tone="ok"
            items={rules.allow}
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
  // Build a fast lookup: pattern → source (first occurrence wins, matching
  // loadCcPermissionsAttributed priority order).
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
