"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useApprovalPatterns } from "../../hooks/useApprovalPatterns";
import { apiPath } from "@/lib/api";
import { CodeBlock, EmptyState, HintCard, KeyChip, RelationStrip } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { DecisionsTabs } from "@/components/DecisionsTabs";
import { useToast } from "@/components/Toast";
import { CountdownTimer } from "./_components/CountdownTimer";
import { Spinner } from "./_components/Spinner";
import { RiskMeter } from "./_components/RiskMeter";

interface RiskSignal {
  kind: "destructive_flag" | "domain_reputation" | "path_escape" | "chaining";
  label: string;
  severity: "low" | "medium" | "high";
}

/**
 * personalSignals = the user's RELATIONSHIP to this call (history,
 * novelty, workflow patterns). Distinct from riskSignals which describe
 * the call's CONTENT (destructive flags, etc.). Both render as chip
 * rows under the summary, but personal signals get their own visual
 * group so the user can tell "the policy thinks this is dangerous"
 * (riskSignals) from "you've done this before / this is unusual for
 * you" (personalSignals).
 *
 * Catalog defined in src/approvalSignals.ts (12 heuristics) — kind is
 * loosely typed here so the dashboard doesn't have to recompile every
 * time a new heuristic ships.
 */
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
  personalSignals?: PersonalSignal[];
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

// --- ApprovalCard ---

interface ApprovalCardProps {
  p: Pending;
  rules: CcRules | null;
  isExpanded: boolean;
  onToggleExpand: (callId: string) => void;
  onDecide: (
    callId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) => Promise<void>;
  isSelected: boolean;
  onToggleSelect: (callId: string) => void;
  fadingOut: boolean;
  isKeyboardFocused?: boolean;
  // Set by the keyboard-shortcut path so the card can show in-flight
  // visual feedback even when the decision was made via E/X (bypassing
  // local approving/rejecting state). Audit gap: mashing E used to give
  // no visual signal that the call was in progress.
  externalInFlight?: "approve" | "reject" | null;
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
  isKeyboardFocused = false,
  externalInFlight = null,
}: ApprovalCardProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const toast = useToast();
  const [editCopied, setEditCopied] = useState(false);
  const [cliCopied, setCliCopied] = useState(false);
  const [paramsCopied, setParamsCopied] = useState(false);

  const expires = p.expiresAt ?? p.requestedAt + DEFAULT_TTL_MS;
  const primary = primaryParam(p.toolName, p.params);
  const hasParams = p.params && Object.keys(p.params).length > 0;
  const match = matchRule(p.toolName, rules);

  // Tick once per second so we can flip to "expired" UI when `expires`
  // passes without depending on the parent re-rendering. Only runs while
  // not yet expired — once `now >= expires` the interval clears itself.
  const [now, setNow] = useState(() => Date.now());
  const expired = now >= expires;
  useEffect(() => {
    if (expired) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expired]);

  // Merge external (keyboard-path) in-flight state with the card's own.
  // The button visuals respect either source so users see a spinner
  // regardless of which path drove the decision.
  const isApproving = approving || externalInFlight === "approve";
  const isRejecting = rejecting || externalInFlight === "reject";

  async function handleDecide(decision: "approve" | "reject") {
    if (expired) {
      toast.error("This approval has expired — the agent has moved on.");
      return;
    }
    // Confirm before approving a single high-tier tool call. Bulk approve
    // already confirms at ≥3 (batchDecide); the matching gate for single
    // approves was missing — a stray click on a high-tier Bash `rm -rf`
    // approved instantly.
    if (decision === "approve" && p.tier === "high") {
      const proceed = window.confirm(
        `Approve high-risk ${p.toolName}? This cannot be undone.`,
      );
      if (!proceed) return;
    }
    // Collect a rejection reason for high-tier denials so the audit log
    // has provenance for "why was this blocked?" investigations. Empty
    // string cancels (matches window.prompt's null-on-cancel semantics).
    let reason: string | undefined;
    if (decision === "reject" && p.tier === "high") {
      const entered = window.prompt(
        `Why are you rejecting ${p.toolName}? (logged for audit; max 500 chars)`,
        "",
      );
      if (entered === null) return; // user hit cancel
      reason = entered.trim() || undefined;
    }
    if (decision === "approve") setApproving(true);
    else setRejecting(true);
    try {
      await onDecide(p.callId, decision, reason);
    } catch (e) {
      toast.error(
        `${decision === "approve" ? "Approve" : "Reject"} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      setApproving(false);
      setRejecting(false);
    }
  }

  const heading = invocationHeading(p.toolName, p.params);
  const diff = diffPreview(p.toolName, p.params ?? {});
  const codeLines = diff
    ? null
    : commandPreview(p.toolName, p.params ?? {}).split("\n");
  const icon = toolIcon(p.toolName);

  const cardRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isKeyboardFocused && cardRef.current) {
      cardRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isKeyboardFocused]);

  return (
    <article
      ref={cardRef}
      className="card"
      style={{
        opacity: fadingOut ? 0 : 1,
        transform: fadingOut ? "translateY(-4px)" : "translateY(0)",
        transition: "opacity 300ms ease, transform 300ms ease, box-shadow 150ms ease, border-color 150ms ease",
        padding: "16px 18px",
        marginBottom: "var(--s-3)",
        outline: isKeyboardFocused ? "2px solid var(--accent)" : "none",
        outlineOffset: isKeyboardFocused ? 2 : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(p.callId)}
          aria-label={`Select ${p.toolName} approval ${p.callId.slice(0, 8)}`}
          style={{ cursor: "pointer", accentColor: "var(--accent)", flexShrink: 0, marginTop: 4 }}
        />
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: 6,
            background: "var(--recess)",
            border: "1px solid var(--line-1)",
            fontSize: "var(--fs-base)",
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--fs-base)", fontWeight: 700, color: "var(--ink-0)", overflowWrap: "anywhere" }}>
            {heading}
          </h3>
        </div>
        <RiskMeter level={p.tier} />
        {match && (
          <span className={`pill ${ruleClass(match)}`} style={{ flexShrink: 0 }}>
            CC: {match}
          </span>
        )}
        {p.sessionId && (
          <span className="pill muted" title={`Session: ${p.sessionId}`} style={{ flexShrink: 0 }}>
            {p.sessionId.slice(0, 8)}
          </span>
        )}
        <span style={{ flexShrink: 0 }}>
          {expired ? (
            <span
              className="pill err"
              title="The agent's request window has passed — approving now will likely 404."
              style={{ fontSize: "var(--fs-xs)" }}
            >
              Expired
            </span>
          ) : (
            <CountdownTimer expiresAt={expires} />
          )}
        </span>
      </div>

      {p.summary && (
        <p style={{ margin: "10px 0 0 52px", fontSize: "var(--fs-m)", color: "var(--ink-2)", lineHeight: 1.5 }}>
          {p.summary}
        </p>
      )}

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

      {p.personalSignals && p.personalSignals.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginTop: 6,
          }}
        >
          {p.personalSignals.map((s) => (
            <span
              key={`personal-${s.kind}-${s.label}`}
              className={`pill ${s.severity === "high" ? "err" : s.severity === "medium" ? "warn" : "muted"}`}
              // Title shows kind + source so a future "why this signal?"
              // popover has somewhere to start; for now it's hover text.
              title={`${s.kind} (from ${s.source})`}
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
            aria-controls={`approval-params-${p.callId}`}
          >
            {isExpanded ? "▾" : "▸"} Full params
            {!isExpanded && p.params && (
              <span className="muted" style={{ marginLeft: 6 }}>
                {Object.keys(p.params).join(", ")}
              </span>
            )}
          </button>
          {isExpanded && (
            <div id={`approval-params-${p.callId}`} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(safeStringify(p.params)).then(() => {
                    setParamsCopied(true);
                    setTimeout(() => setParamsCopied(false), 1400);
                  });
                }}
                aria-label="Copy params as JSON"
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  fontSize: "var(--fs-xs)",
                  padding: "3px 8px",
                  borderRadius: 4,
                  background: "var(--surface)",
                  border: "1px solid var(--line-1)",
                  color: paramsCopied ? "var(--ok)" : "var(--ink-2)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  zIndex: 1,
                }}
              >
                {paramsCopied ? "✓ Copied" : "Copy JSON"}
              </button>
              <pre className="approval-params-json">
                {safeStringify(p.params)}
              </pre>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, marginLeft: 52 }}>
        {diff ? (
          <CodeBlock>
            <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)", marginBottom: 4 }}>
              {diff.path}
            </div>
            {diff.lines.map((line, i) => {
              const bg =
                line.kind === "add"
                  ? "rgba(34, 197, 94, 0.12)"
                  : line.kind === "del"
                    ? "rgba(239, 68, 68, 0.12)"
                    : "transparent";
              const color =
                line.kind === "add"
                  ? "var(--ok)"
                  : line.kind === "del"
                    ? "var(--err)"
                    : "var(--ink-2)";
              const prefix =
                line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
              return (
                <div key={i} style={{ display: "flex", background: bg }}>
                  <span
                    aria-hidden="true"
                    style={{
                      color,
                      minWidth: 18,
                      textAlign: "center",
                      userSelect: "none",
                    }}
                  >
                    {prefix}
                  </span>
                  <span
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      color,
                    }}
                  >
                    {line.text}
                  </span>
                </div>
              );
            })}
            {diff.truncated && (
              <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)", marginTop: 4 }}>
                … truncated. Expand &quot;Full params&quot; for the complete payload.
              </div>
            )}
          </CodeBlock>
        ) : (
          <CodeBlock>
            {codeLines?.map((line, i) => (
              <div key={i} style={{ display: "flex" }}>
                <span style={{ color: "var(--ink-3)", minWidth: 28, textAlign: "right", paddingRight: 12, userSelect: "none" }}>
                  {i + 1}
                </span>
                <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
              </div>
            ))}
          </CodeBlock>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, marginLeft: 52, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn primary"
          style={{ background: "var(--green)", borderColor: "var(--green)", color: "var(--on-accent)", display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => handleDecide("approve")}
          disabled={isApproving || isRejecting || expired}
          title={expired ? "Expired — the agent has moved on" : undefined}
          aria-label={`Approve ${p.toolName}`}
        >
          {isApproving ? <Spinner /> : <span aria-hidden="true">✓</span>}
          {isApproving ? " Approving…" : " Approve"}
          <KeyChip>E</KeyChip>
        </button>
        <button
          type="button"
          className="btn danger"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => handleDecide("reject")}
          disabled={isApproving || isRejecting || expired}
          title={expired ? "Expired — the agent has moved on" : undefined}
          aria-label={`Reject ${p.toolName}`}
        >
          {isRejecting ? <Spinner /> : <span aria-hidden="true">✗</span>}
          {isRejecting ? " Rejecting…" : " Reject"}
          <KeyChip>X</KeyChip>
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            navigator.clipboard.writeText(`patchwork approve --edit ${p.callId}`).then(() => {
              setEditCopied(true);
              setTimeout(() => setEditCopied(false), 1500);
            });
          }}
        >
          {editCopied ? "Copied!" : "Edit & approve"}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          style={{ fontFamily: "var(--font-mono)" }}
          onClick={() => {
            navigator.clipboard.writeText(`patchwork approve ${p.callId}`).then(() => {
              setCliCopied(true);
              setTimeout(() => setCliCopied(false), 1500);
            });
          }}
        >
          {cliCopied ? "Copied!" : "› Open in terminal"}
        </button>
      </div>

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
        // Lift above the mobile bottom-nav (--bottom-nav-h is 0 on desktop,
        // 62px on phones); env() adds the iPhone safe-area inset.
        bottom: "calc(var(--s-6) + var(--bottom-nav-h, 0px) + env(safe-area-inset-bottom, 0px))",
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
      <span style={{ fontSize: "var(--fs-m)", color: "var(--fg-1)", fontWeight: 500 }}>
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
  const [hasLoaded, setHasLoaded] = useState(false);
  const [rules, setRules] = useState<CcRules | null>(null);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const riskFromUrl = searchParams.get("risk");
  const [riskFilter, setRiskFilterState] = useState<RiskFilter>(
    riskFromUrl === "low" || riskFromUrl === "medium" || riskFromUrl === "high"
      ? riskFromUrl
      : "all",
  );
  const setRiskFilter = (next: RiskFilter) => {
    setRiskFilterState(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("risk");
    else params.set("risk", next);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());
  const [batchApproving, setBatchApproving] = useState(false);
  const [batchRejecting, setBatchRejecting] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const inFlightRef = useRef<Set<string>>(new Set());
  // State-backed mirror of in-flight decisions made via the keyboard
  // path (E/X). The ref alone doesn't trigger re-renders, so cards
  // gave no visual feedback when a keystroke was already in motion.
  const [kbdInFlight, setKbdInFlight] = useState<Record<string, "approve" | "reject">>({});
  const { patterns, clearPatterns } = useApprovalPatterns();

  useEffect(() => {
    // Load CC permissions once (changes rarely) — used to show the inline
    // "CC: allow|ask|deny" badge on each card.
    fetch(`${API}/cc-permissions`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setRules(d as CcRules); })
      .catch(() => { /* badge silently absent */ });
  }, []);

  useEffect(() => {
    const qs = sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : "";
    const streamUrl = apiPath(`/api/bridge/approvals/stream${qs}`);

    let es: EventSource | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    // Once SSE has failed this many times (without a successful event in
    // between), stay on polling and stop trying to reconnect — prevents a
    // tight retry loop when the bridge upstream is missing /approvals/stream.
    const MAX_SSE_FAILURES = 3;
    let sseFailures = 0;
    let sawSseEvent = false;

    function applySnapshot(data: string) {
      try {
        setPending(JSON.parse(data) as Pending[]);
        setHasLoaded(true);
        setErr(undefined);
      } catch { /* ignore parse errors */ }
    }

    function startSSE() {
      if (!alive || typeof EventSource === "undefined") return;
      if (sseFailures >= MAX_SSE_FAILURES) {
        startPolling();
        return;
      }
      sawSseEvent = false;
      es = new EventSource(streamUrl);
      const onEvent = (e: Event) => {
        sawSseEvent = true;
        sseFailures = 0;
        applySnapshot((e as MessageEvent).data);
      };
      es.addEventListener("snapshot", onEvent);
      es.addEventListener("update", onEvent);
      es.addEventListener("bridge-error", () => {
        // Bridge down event from SSE — fall back to polling
        if (!sawSseEvent) sseFailures++;
        es?.close();
        es = null;
        startPolling();
      });
      es.onerror = () => {
        // SSE unavailable (e.g. old bridge) — fall back to polling
        if (!sawSseEvent) sseFailures++;
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
          setHasLoaded(true);
          setErr(undefined);
          // Bridge HTTP is reachable. Only try to re-establish SSE if we
          // haven't already exhausted retries — otherwise polling is fine
          // and re-opening would just loop on the same upstream error.
          if (sseFailures < MAX_SSE_FAILURES) {
            if (pollId !== null) {
              clearInterval(pollId);
              pollId = null;
            }
            startSSE();
          }
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

  // Fade-out then remove. The 320ms timeout outlives a route change, so
  // track + clear pending timeouts when the component unmounts to avoid
  // updating state on a torn-down tree.
  const fadeTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = fadeTimersRef.current;
    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);
  function removeWithFade(callId: string) {
    setFadingOut((prev) => new Set([...prev, callId]));
    const timer = setTimeout(() => {
      fadeTimersRef.current.delete(timer);
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
    fadeTimersRef.current.add(timer);
  }

  async function decide(
    callId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) {
    const init: RequestInit = { method: "POST" };
    if (reason && reason.trim().length > 0) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify({ reason: reason.trim().slice(0, 500) });
    }
    const res = await fetch(`${API}/${decision}/${callId}`, init);
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
    if (ids.length >= 3) {
      const verb = decision === "approve" ? "Approve" : "Reject";
      const proceed = window.confirm(
        `${verb} ${ids.length} approvals at once? This action can't be undone.`,
      );
      if (!proceed) return;
    }
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

  // Clamp focus index when the visible list shrinks.
  useEffect(() => {
    setFocusIndex((i) => {
      if (filtered.length === 0) return 0;
      return Math.min(i, filtered.length - 1);
    });
  }, [filtered.length]);

  // J/K/E/X keyboard shortcuts. Skip when typing in inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t.isContentEditable
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (filtered.length === 0) return;

      const key = e.key.toLowerCase();
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(i - 1, 0));
      } else if (key === "e" || key === "x") {
        const target = filtered[focusIndex];
        if (!target) return;
        if (inFlightRef.current.has(target.callId)) return;
        e.preventDefault();
        const choice = key === "e" ? "approve" : "reject";
        const verb = key === "e" ? "Approved" : "Rejected";
        // Confirm high-tier approves on keyboard path too — matches the
        // mouse path guard added to handleDecide.
        if (choice === "approve" && target.tier === "high") {
          const proceed = window.confirm(
            `Approve high-risk ${target.toolName}? This cannot be undone.`,
          );
          if (!proceed) return;
        }
        let kbdReason: string | undefined;
        if (choice === "reject" && target.tier === "high") {
          const entered = window.prompt(
            `Why are you rejecting ${target.toolName}? (logged for audit; max 500 chars)`,
            "",
          );
          if (entered === null) return;
          kbdReason = entered.trim() || undefined;
        }
        inFlightRef.current.add(target.callId);
        setKbdInFlight((prev) => ({ ...prev, [target.callId]: choice }));
        decide(target.callId, choice, kbdReason)
          .then(() => setAnnouncement(`${verb} ${target.toolName}`))
          .catch((err: unknown) =>
            setAnnouncement(
              `${choice} failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(() => {
            inFlightRef.current.delete(target.callId);
            setKbdInFlight((prev) => {
              if (!(target.callId in prev)) return prev;
              const next = { ...prev };
              delete next[target.callId];
              return next;
            });
          });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, focusIndex]);

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

      <DecisionsTabs pendingCount={pending.length} />

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {announcement}
      </div>

      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 className="editorial-h1" style={{ margin: 0 }}>
              Approval queue — <span className="accent">nothing leaves your machine without a nod.</span>
            </h1>
            <HintCard.Toggle id="approvals" />
          </div>
          <div className="editorial-sub">
            {(() => {
              const oldestTs = pending.length > 0
                ? pending.reduce(
                    (m, p) => Math.min(m, p.requestedAt ?? p.expiresAt ?? Date.now()),
                    Number.POSITIVE_INFINITY,
                  )
                : null;
              return `~/.patchwork/inbox · ${pending.length} pending${oldestTs ? ` · oldest ${relTime(oldestTs)}` : ""}`;
            })()}
          </div>
          <RelationStrip
            items={[
              { label: "Insights", href: "/insights", title: "Approve/reject patterns across tools" },
              {
                label: "Suggestions",
                href: "/suggestions",
                tone: pending.length > 0 ? "accent" : "neutral",
                title: "Policy tweaks the system suggests",
              },
              { label: "Settings", href: "/settings#approvals", title: "Configure approval rules" },
              { label: "Knowledge", href: "/decisions", title: "Saved reasoning your agents wrote down" },
            ]}
          />
          <div
            className="kbd-hint-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              marginTop: 8,
              fontSize: "var(--fs-xs)",
              color: "var(--ink-3)",
              flexWrap: "wrap",
            }}
            aria-label="Keyboard shortcuts"
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <KeyChip>J</KeyChip> next
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <KeyChip>K</KeyChip> prev
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <KeyChip>E</KeyChip> approve
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <KeyChip>X</KeyChip> reject
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <KeyChip>⌘K</KeyChip> palette
            </span>
            {/*
              Cross-link to Approval Insights. Before this link, the
              /insights page (per-tool approval/rejection patterns,
              explain-batch, replay) had no entry point from the
              approval queue — the two pages share the same data but
              the dashboard never told the user that.
            */}
            <span style={{ color: "var(--line-2)" }} aria-hidden="true">·</span>
            <Link
              href="/insights"
              style={{ color: "var(--ink-2)", textDecoration: "none" }}
            >
              See approval patterns →
            </Link>
          </div>
        </div>
        <span className={`pill ${pending.length > 0 ? "warn" : "ok"}`}>
          {pending.length} pending
        </span>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            const approvalsUrl = `${API}/approvals${sessionFilter ? `?session=${sessionFilter}` : ""}`;
            fetch(approvalsUrl)
              .then((r) => r.ok ? r.json() : null)
              .then((d) => { if (d) setPending(d as Pending[]); })
              .catch(() => {});
          }}
        >
          Sync inbox
        </button>
      </div>

      <HintCard id="approvals" />

      {/* Hero status bar — counts by tier. When the queue is empty the
          tier breakdown is all zeros — collapse it to avoid repeating
          "0 pending" + "All clear" + four zero-tiles. The historical rate
          strip (below) stays visible if there are past decisions. */}
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
              fontSize: "var(--fs-2xs)",
              color: "var(--ink-2)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 4,
            }}
          >
            Queue
          </div>
          <div style={{ fontSize: "var(--fs-3xl)", fontWeight: 800, color: "var(--ink-0)", lineHeight: 1.1 }}>
            {pending.length === 0 ? "All clear" : `${pending.length} awaiting decision`}
          </div>
        </div>
        {pending.length > 0 && (
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
                      fontSize: "var(--fs-2xs)",
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
        )}

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
              <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Historical rate
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span
                  className="pill ok"
                  style={{ fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", fontWeight: 700 }}
                  title={`${totalApproved} approved`}
                >
                  {approvePct}% approved
                </span>
                <span
                  className="pill err"
                  style={{ fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", fontWeight: 700 }}
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
              <div style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-3)" }}>
                {total} decision{total !== 1 ? "s" : ""} this session
              </div>
            </div>
          );
        })()}
      </div>

      {/* Risk filter buttons — hidden when there's nothing to filter */}
      {pending.length > 0 && (
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
      )}

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
        hasLoaded ? (
          <EmptyState
            icon={
              <span style={{ fontSize: 48, lineHeight: 1, color: "var(--ok)" }} aria-hidden="true">
                ✓
              </span>
            }
            title="All caught up!"
            description={
              riskFilter !== "all"
                ? `No ${riskFilter} risk approvals pending.`
                : "No pending approvals. All tool calls handled by policy or already decided."
            }
            action={
              riskFilter !== "all" ? (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => setRiskFilter("all")}
                  style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
                >
                  Clear filter
                </button>
              ) : undefined
            }
          />
        ) : (
          <SkeletonList rows={3} columns={3} />
        )
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
              <span style={{ fontSize: "var(--fs-s)", color: "var(--fg-2)" }}>
                Select all
              </span>
            </div>
          )}

          <div className="approval-list">
            {filtered.map((p, idx) => (
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
                isKeyboardFocused={idx === focusIndex}
                externalInFlight={kbdInFlight[p.callId] ?? null}
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
              fontSize: "var(--fs-m)",
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
                    fontSize: "var(--fs-m)",
                    color: "var(--fg-0)",
                    flex: 1,
                    minWidth: 140,
                  }}
                >
                  {toolName}
                </code>
                <span
                  style={{ fontSize: "var(--fs-m)", color: "var(--fg-2)", flexShrink: 0 }}
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

    </section>
  );
}

function toolIcon(toolName: string): string {
  const lc = toolName.toLowerCase();
  if (lc.includes("bash") || lc.includes("shell") || lc.includes("terminal") || lc.includes("run")) return "$_";
  if (lc.includes("github") || lc.includes("git")) return "◆";
  if (lc.includes("slack") || lc.includes("post")) return "✉";
  if (lc.includes("linear") || lc.includes("jira") || lc.includes("issue")) return "▤";
  if (lc.includes("fetch") || lc.includes("http") || lc.includes("web")) return "⌬";
  if (lc.includes("write") || lc.includes("edit") || lc.includes("file")) return "✎";
  if (lc.includes("read")) return "▭";
  return "▣";
}

function invocationHeading(toolName: string, params?: Record<string, unknown>): string {
  if (!params) return `${toolName}()`;
  const lc = toolName.toLowerCase();
  if (lc === "bash" || lc.includes("bash")) {
    const cmd = params.command ?? params.cmd;
    if (typeof cmd === "string") return `${toolName}(${cmd})`;
  }
  const primary = primaryParam(toolName, params);
  if (primary) return `${toolName}(${primary})`;
  return `${toolName}()`;
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

/**
 * Keys matched here (case-insensitive, substring) have their values
 * redacted to "***" when serialised for display. Audit caught that
 * tool params (e.g. `runHttpRequest` with an Authorization header,
 * connector configs) were rendered verbatim — anyone shoulder-surfing
 * an approval card could read out a live bearer token.
 *
 * Conservative: a key has to look secret-shaped. Adding noise (e.g. an
 * api `key` field that's just a category id) is far less bad than
 * leaking a real secret.
 */
const REDACT_KEY_PATTERN = /(token|secret|password|api[_-]?key|auth(orization)?|bearer|cookie|session[_-]?id|private[_-]?key)/i;

function redactValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redactValue);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (REDACT_KEY_PATTERN.test(k) && typeof val === "string" && val.length > 0) {
      out[k] = "***";
    } else {
      out[k] = redactValue(val);
    }
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(redactValue(v), null, 2);
  } catch {
    return String(v);
  }
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

/**
 * Build a readable preview for Edit / Write tool calls. Old: rendered
 * `path\ncontent.slice(0,200)` which truncated mid-token and gave no
 * visual cue for what was changing — auditors had to expand "Full
 * params" and squint at JSON to see the diff.
 *
 * Edit: emit "-" lines for old_string, "+" lines for new_string. Not
 *   a true LCS — that needs O(n·m) and a diff lib; for the typical
 *   small Edit hunk a side-by-side old/new is plenty.
 * Write: emit "+" lines for the full content (capped at 50 lines).
 * MultiEdit: same as Edit per hunk.
 *
 * Returns null when the tool isn't an edit-shaped writer — callers
 * fall back to commandPreview().
 */
function diffPreview(
  toolName: string,
  params: Record<string, unknown>,
): { path: string; lines: DiffLine[]; truncated: boolean } | null {
  const lc = toolName.toLowerCase();
  const isEdit = lc === "edit" || lc === "multiedit";
  const isWrite = lc === "write";
  if (!isEdit && !isWrite) return null;
  const path =
    String(params.file_path ?? params.path ?? params.filePath ?? "") || "(no path)";
  const MAX_LINES_PER_SIDE = 25;
  const lines: DiffLine[] = [];

  if (isWrite) {
    const content = String(params.content ?? "");
    const all = content.split("\n");
    const shown = all.slice(0, MAX_LINES_PER_SIDE * 2);
    for (const t of shown) lines.push({ kind: "add", text: t });
    return { path, lines, truncated: all.length > shown.length };
  }

  // Edit / MultiEdit
  const hunks =
    Array.isArray(params.edits) && params.edits.length > 0
      ? (params.edits as Array<Record<string, unknown>>)
      : [{ old_string: params.old_string, new_string: params.new_string }];
  let truncated = false;
  for (const h of hunks) {
    const oldLines = String(h.old_string ?? "").split("\n");
    const newLines = String(h.new_string ?? "").split("\n");
    const oldShown = oldLines.slice(0, MAX_LINES_PER_SIDE);
    const newShown = newLines.slice(0, MAX_LINES_PER_SIDE);
    if (oldShown.length < oldLines.length || newShown.length < newLines.length) {
      truncated = true;
    }
    for (const t of oldShown) lines.push({ kind: "del", text: t });
    for (const t of newShown) lines.push({ kind: "add", text: t });
  }
  return { path, lines, truncated };
}

function commandPreview(toolName: string, params: Record<string, unknown>): string {
  const lc = toolName.toLowerCase();
  if (lc.includes("bash") || lc.includes("run") || lc.includes("terminal")) {
    return String(params.command ?? params.cmd ?? JSON.stringify(params));
  }
  if (lc.includes("fetch") || lc.includes("http")) {
    return `${params.method ?? "GET"} ${params.url ?? ""}`;
  }
  if (lc.includes("write") || lc.includes("edit") || lc.includes("file")) {
    const path = params.file_path ?? params.path ?? params.filePath ?? "";
    return `${path}\n${String(params.content ?? params.new_string ?? "").slice(0, 200)}`;
  }
  return JSON.stringify(params, null, 2).slice(0, 400);
}
