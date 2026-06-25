"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useApprovalPatterns } from "../../hooks/useApprovalPatterns";
import { apiPath } from "@/lib/api";
import { CodeBlock, EmptyState, HintCard, KeyChip } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { DecisionsTabs } from "@/components/DecisionsTabs";
import { useToast } from "@/components/Toast";
import { CountdownTimer } from "./_components/CountdownTimer";
import { Spinner } from "./_components/Spinner";
import { RiskMeter } from "./_components/RiskMeter";
import { syntaxHighlightJson } from "@/lib/syntaxHighlight";

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

const ApprovalCard = memo(function ApprovalCard({
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
  const editCopyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cliCopyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paramsCopyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(editCopyTimerRef.current);
    clearTimeout(cliCopyTimerRef.current);
    clearTimeout(paramsCopyTimerRef.current);
  }, []);

  const expires = p.expiresAt ?? p.requestedAt + DEFAULT_TTL_MS;
  const primary = primaryParam(p.toolName, p.params);
  const hasParams = p.params && Object.keys(p.params).length > 0;
  const match = matchRule(p.toolName, rules);

  // Flip to "expired" UI exactly once when `expires` passes. Previously
  // ticked Date.now() at 1Hz per card, which forced every visible card
  // to re-render every second even though the countdown UI is owned by
  // a leaf <CountdownTimer> that ticks itself. Now a single setTimeout
  // schedules the boolean flip and unmounts. Perf audit 2026-05-19.
  const [expired, setExpired] = useState(() => Date.now() >= expires);
  useEffect(() => {
    if (expired) return;
    const remaining = expires - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const id = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(id);
  }, [expires, expired]);

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
      toast.success(decision === "approve" ? "Approved" : "Denied");
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

  const urgencyClass =
    p.tier === "high" ? "apc-urgent-high" :
    p.tier === "medium" ? "apc-urgent-medium" : "";

  return (
    <article
      ref={cardRef}
      className={`card apc apc-entrance ${urgencyClass}`}
      data-fading={fadingOut ? "true" : undefined}
      data-kbd-focus={isKeyboardFocused ? "true" : undefined}
    >
      <div className="apc-header">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(p.callId)}
          aria-label={`Select ${p.toolName} approval ${p.callId.slice(0, 8)}`}
        />
        <span aria-hidden="true" className="apc-icon">{icon}</span>
        <div className="apc-body">
          <h3 className="apc-title">{heading}</h3>
        </div>
        <RiskMeter level={p.tier} />
        {match && (
          <span className={`pill ${ruleClass(match)} apc-shrink0`}>
            CC: {match}
          </span>
        )}
        {p.sessionId && (
          <span className="pill muted apc-shrink0" title={`Session: ${p.sessionId}`}>
            {p.sessionId.slice(0, 8)}
          </span>
        )}
        <span className="apc-shrink0">
          {expired ? (
            <span
              className="pill err apc-expired-pill"
              title="The agent's request window has passed — approving now will likely 404."
            >
              Expired
            </span>
          ) : (
            <CountdownTimer expiresAt={expires} />
          )}
        </span>
      </div>

      {p.summary && (
        <p className="apc-summary">{p.summary}</p>
      )}

      {p.riskSignals && p.riskSignals.length > 0 && (
        <div className="apc-signals">
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
        <div className="apc-signals">
          {p.personalSignals.map((s) => (
            <span
              key={`personal-${s.kind}-${s.label}`}
              className={`pill ${s.severity === "high" ? "err" : s.severity === "medium" ? "warn" : "muted"}`}
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
              <span className="muted apc-params-key-list">
                {Object.keys(p.params).join(", ")}
              </span>
            )}
          </button>
          {isExpanded && (
            <div id={`approval-params-${p.callId}`} className="apc-params-body">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(safeStringify(p.params)).then(() => {
                    setParamsCopied(true);
                    clearTimeout(paramsCopyTimerRef.current);
                    paramsCopyTimerRef.current = setTimeout(() => setParamsCopied(false), 1400);
                  });
                }}
                aria-label="Copy params as JSON"
                className="apc-params-copy"
                data-copied={paramsCopied ? "true" : undefined}
              >
                {paramsCopied ? "✓ Copied" : "Copy JSON"}
              </button>
              <pre
                className="approval-params-json"
                // LOW #42: use syntaxHighlightJson (same as detail page) for
                // consistent rendering and HTML-safe output.
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{
                  __html: syntaxHighlightJson(safeStringify(p.params)),
                }}
              />
            </div>
          )}
        </div>
      )}

      <div className="apc-code">
        {diff ? (
          <CodeBlock>
            <div className="apc-diff-path">{diff.path}</div>
            {diff.lines.map((line, i) => {
              const kind = line.kind === "add" ? "add" : line.kind === "del" ? "del" : "ctx";
              const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
              return (
                <div key={i} className="apc-diff-line" data-kind={kind}>
                  <span aria-hidden="true" className="apc-diff-prefix" data-kind={kind}>{prefix}</span>
                  <span className="apc-diff-text" data-kind={kind}>{line.text}</span>
                </div>
              );
            })}
            {diff.truncated && (
              <div className="apc-diff-truncated">
                … truncated. Expand &quot;Full params&quot; for the complete payload.
              </div>
            )}
          </CodeBlock>
        ) : (
          <CodeBlock>
            {codeLines?.map((line, i) => (
              <div key={i} className="apc-code-line">
                <span className="apc-line-num">{i + 1}</span>
                <span className="apc-line-text">{line}</span>
              </div>
            ))}
          </CodeBlock>
        )}
      </div>

      {/* Decision cluster kept on its own row so Approve and Reject stay
          together at all viewport widths. Audit caught that the previous
          single flex-wrap row could split the destructive button onto
          a different line from "Edit & approve", increasing fat-finger
          risk on phones. Secondary actions (copy commands) live below in
          a separate flex group. */}
      <div className="apc-decisions">
        <button
          type="button"
          className="btn primary apc-approve-btn"
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
          className="btn danger apc-deny-btn"
          onClick={() => handleDecide("reject")}
          disabled={isApproving || isRejecting || expired}
          title={expired ? "Expired — the agent has moved on" : undefined}
          aria-label={`Reject ${p.toolName}`}
        >
          {isRejecting ? <Spinner /> : <span aria-hidden="true">✗</span>}
          {isRejecting ? " Rejecting…" : " Reject"}
          <KeyChip>X</KeyChip>
        </button>
      </div>
      <div className="apc-actions">
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            navigator.clipboard.writeText(`patchwork approve --edit ${p.callId}`).then(() => {
              setEditCopied(true);
              clearTimeout(editCopyTimerRef.current);
              editCopyTimerRef.current = setTimeout(() => setEditCopied(false), 1500);
            });
          }}
        >
          {editCopied ? "Copied!" : "Edit & approve"}
        </button>
        <button
          type="button"
          className="btn sm ghost mono"
          onClick={() => {
            navigator.clipboard.writeText(`patchwork approve ${p.callId}`).then(() => {
              setCliCopied(true);
              clearTimeout(cliCopyTimerRef.current);
              cliCopyTimerRef.current = setTimeout(() => setCliCopied(false), 1500);
            });
          }}
        >
          {cliCopied ? "Copied!" : "› Open in terminal"}
        </button>
      </div>

    </article>
  );
});

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
    <div className="approval-batch-bar" role="toolbar" aria-label="Batch actions">
      <span className="approval-batch-count">{selectedCount} selected</span>
      <span className="approval-spacer" />
      <button
        type="button"
        className="btn primary"
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
  const recipeFilter = searchParams.get("recipe");

  const [pending, setPending] = useState<Pending[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [rules, setRules] = useState<CcRules | null>(null);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const copyRuleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyRuleTimerRef.current); }, []);
  const toast = useToast();
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
          const approvalsUrl = `${API}/approvals${sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : ""}`;
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

  const decide = useCallback(
    async (callId: string, decision: "approve" | "reject", reason?: string) => {
      const init: RequestInit = { method: "POST" };
      if (reason && reason.trim().length > 0) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({ reason: reason.trim().slice(0, 500) });
      }
      const res = await fetch(`${API}/${decision}/${callId}`, init);
      if (!res.ok) {
        if (res.status === 409) {
          // Another session already decided this call — treat as success
          // so the card fades out rather than showing a confusing error.
          removeWithFade(callId);
          return;
        }
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${decision} failed: ${text || res.status}`);
      }
      removeWithFade(callId);
    },
    [],
  );

  const toggleExpand = useCallback((callId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((callId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }, []);

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
    // Confirm gate is tier-weighted: any high-risk selection demands a
    // confirm even for a batch of 1; non-high batches keep the historical
    // ≥3 threshold so the prompt doesn't become noise for tidy reviews.
    const highCount = selectedInView.filter((p) => p.tier === "high").length;
    const needsConfirm = highCount > 0 || ids.length >= 3;
    if (needsConfirm) {
      const verb = decision === "approve" ? "Approve" : "Reject";
      const highNote =
        highCount > 0
          ? ` (${highCount} high-risk)`
          : "";
      const proceed = window.confirm(
        `${verb} ${ids.length} approval${ids.length === 1 ? "" : "s"}${highNote}? This action can't be undone.`,
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
    } catch (e) {
      setBatchErr(e instanceof Error ? e.message : `${decision} request failed`);
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
      clearTimeout(copyRuleTimerRef.current);
      copyRuleTimerRef.current = setTimeout(() => setCopied((c) => (c === toolName ? null : c)), 2000);
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

      <DecisionsTabs pendingCount={pending.length} />

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="page-head">
        <div>
          <div className="page-head-title-row">
            <h1 className="editorial-h1">
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
          {/* The related-links strip (Insights / Suggestions / Settings /
              Knowledge) was redundant here: Suggested + Knowledge are the
              DecisionsTabs above, and Insights is the "See approval
              patterns" link below. Dropped the strip to declutter the
              header; the one unique destination (approval rule settings)
              moves into the hint row. */}
          <div className="kbd-hint-row" aria-label="Keyboard shortcuts">
            <span><KeyChip>J</KeyChip> next</span>
            <span><KeyChip>K</KeyChip> prev</span>
            <span><KeyChip>E</KeyChip> approve</span>
            <span><KeyChip>X</KeyChip> reject</span>
            <span><KeyChip>⌘K</KeyChip> palette</span>
            <span className="kbd-hint-sep" aria-hidden="true">·</span>
            <Link href="/insights">See approval patterns →</Link>
            <span className="kbd-hint-sep" aria-hidden="true">·</span>
            <Link href="/settings#approvals">Configure rules →</Link>
          </div>
        </div>
        <span className={`pill ${pending.length > 0 ? "warn" : "ok"}`}>
          {pending.length} pending
        </span>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            const approvalsUrl = `${API}/approvals${sessionFilter ? `?session=${encodeURIComponent(sessionFilter)}` : ""}`;
            fetch(approvalsUrl)
              .then(async (r) => {
                if (!r.ok) {
                  const detail = await r.text().catch(() => r.statusText);
                  throw new Error(detail || `${r.status}`);
                }
                return r.json();
              })
              .then((d) => {
                if (d) setPending(d as Pending[]);
                toast.info("Inbox synced");
              })
              .catch((e: unknown) => {
                toast.error(
                  `Sync failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              });
          }}
        >
          Sync inbox
        </button>
      </div>

      <HintCard id="approvals" />

      {/* Hero status bar — counts by tier. When the queue is empty this
          whole card is suppressed: the dedicated "All caught up!"
          EmptyState below is the single empty state, so rendering a
          "Queue — All clear" card here too was a redundant double
          empty-state (UX audit 2026-05-20). The historical rate strip
          still surfaces past decisions via the empty-state path. */}
      {pending.length > 0 && (
      <div className="card apq-hero-card">
        <div className="apq-queue">
          <div className="apq-section-label">Queue</div>
          <div className="apq-count">{`${pending.length} awaiting decision`}</div>
        </div>
        {pending.length > 0 && (
          <div className="apq-stats">
            {([
              { label: "Total", val: counts.all, tone: undefined },
              { label: "High",  val: counts.high,  tone: "err"  },
              { label: "Medium",val: counts.medium, tone: "warn" },
              { label: "Low",   val: counts.low,    tone: "ink1" },
            ] as const).map((s, i) => (
              <div key={s.label} className="apq-stat-wrapper">
                {i > 0 && <span aria-hidden="true" className="apq-divider" />}
                <div className="apq-stat">
                  <div className="apq-stat-value" data-tone={s.tone}>{s.val}</div>
                  <div className="apq-stat-label">{s.label}</div>
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
            <div className="apq-rate">
              <div className="apq-rate-label">Historical rate</div>
              <div className="apq-rate-pills">
                <span className="pill ok apq-rate-pill" title={`${totalApproved} approved`}>
                  {approvePct}% approved
                </span>
                <span className="pill err apq-rate-pill" title={`${totalRejected} rejected`}>
                  {rejectPct}% rejected
                </span>
              </div>
              <div
                className="apq-rate-bar"
                aria-label={`Approval rate: ${approvePct}% approved, ${rejectPct}% rejected`}
              >
                <div className="apq-rate-fill-ok" style={{ width: `${approvePct}%` }} />
                {rejectPct > 0 && <div className="apq-rate-fill-err" />}
              </div>
              <div className="apq-rate-note">
                {total} decision{total !== 1 ? "s" : ""} this session
              </div>
            </div>
          );
        })()}
      </div>
      )}

      {/* Risk filter buttons — hidden when there's nothing to filter */}
      {pending.length > 0 && (
        <div className="filter-chips">
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

      {err && <div className="alert-err" role="alert">Unreachable: {err}</div>}

      {sessionFilter && (
        <div className="alert-info">
          Showing approvals for session{" "}
          <code>{sessionFilter.slice(0, 8)}</code>
          {" · "}
          <button
            type="button"
            className="alert-inline-link"
            onClick={() => router.push("/approvals")}
          >
            Clear filter
          </button>
        </div>
      )}

      {recipeFilter && (
        <div className="apq-recipe-filter">
          <span className="apq-recipe-filter-label">Linked from recipe:</span>
          <code>{recipeFilter}</code>
          <span className="apq-recipe-filter-note">
            · approval payloads don&apos;t carry a recipe identifier — showing all pending approvals
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => router.push("/approvals")}
          >
            Clear
          </button>
        </div>
      )}

      {filtered.length === 0 && !err ? (
        hasLoaded ? (
          <EmptyState
            icon={
              <span className="apq-ok-icon" aria-hidden="true">✓</span>
            }
            title="All caught up!"
            description={
              riskFilter !== "all"
                ? `No ${riskFilter}-risk approvals pending. Your recipes are running smoothly.`
                : "No pending approvals — your recipes are running smoothly. Tool calls are handled by policy or have already been decided."
            }
            action={
              riskFilter !== "all" ? (
                <button
                  type="button"
                  className="btn sm ghost accent"
                  onClick={() => setRiskFilter("all")}
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
            <div className="apq-select-all">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAll}
                aria-label="Select all approvals"
              />
              <span className="apq-select-all-label">Select all</span>
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
            <div className="alert-err mt-3" role="alert">
              {batchErr}
            </div>
          )}
        </>
      )}

      {suggestions.length > 0 && (
        <div className="card apq-suggestions-card">
          <div className="card-head">
            <h2>
              <span aria-hidden="true">💡</span> Pattern suggestions
            </h2>
          </div>
          <p className="apq-suggestions-desc">
            Tools you&apos;ve consistently approved. Copy a JSON snippet to add
            an allow rule.
          </p>
          <div className="apq-suggestions-list">
            {suggestions.map(([toolName, p]) => (
              <div key={toolName} className="apq-suggestion">
                <code className="apq-suggestion-name">{toolName}</code>
                <span className="apq-suggestion-count">approved {p.approved}&times;</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => copyRule(toolName)}
                >
                  {copied === toolName ? "Copied!" : "Copy allow rule"}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={`Dismiss suggestion for ${toolName}`}
                  onClick={() => dismissSuggestion(toolName)}
                >
                  &#x2715;
                </button>
              </div>
            ))}
          </div>
          <div className="apq-suggestions-footer">
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
