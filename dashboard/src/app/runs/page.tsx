"use client";
import React from "react";
import { apiPath } from "@/lib/api";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LivePill } from "@/components/patchwork/LivePill";
import { AnimatedNumber, EmptyState, ErrorState, RelationStrip } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { ActivityTabs } from "@/components/ActivityTabs";
import { useDebounced } from "@/hooks/useDebounced";
import { useBridgeStream } from "@/hooks/useBridgeStream";

interface AssertionFailure {
  assertion: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

function formatRecipeName(name: string, trigger: string): string {
  // Already has colon variant
  if (name.includes(":")) return name;
  const norm = normaliseTrigger(trigger);
  if (norm === "manual") return name;
  // Map to short variant suffix: webhook→hook, recipe→agent, cron→cron, git_hook→git
  const suffix =
    norm === "webhook"
      ? "hook"
      : norm === "recipe"
        ? "agent"
        : norm === "git_hook"
          ? "git"
          : norm;
  return `${name}:${suffix}`;
}

function normaliseTrigger(t: string): string {
  if (t.startsWith("recipe:")) return "recipe";
  if (t.startsWith("cron") || t.startsWith("@")) return "cron";
  if (t.startsWith("webhook") || t.startsWith("yaml-webhook")) return "webhook";
  if (t.startsWith("git_hook")) return "git_hook";
  return "manual";
}

interface Run {
  seq: number;
  taskId: string;
  recipeName: string;
  trigger: string;
  status: "running" | "done" | "error" | "cancelled" | "interrupted";
  createdAt: number;
  startedAt?: number;
  doneAt: number;
  durationMs: number;
  model?: string;
  outputTail?: string;
  errorMessage?: string;
  assertionFailures?: AssertionFailure[];
  /** PR5c — stable id for one logical retry-attempt; ties resumed runs together. */
  manualRunId?: string;
  /** Run finished `done` but ≥1 step ended in error — "completed with
   *  errors". Set by the bridge run log (see runLog.hadStepErrors). */
  hadStepErrors?: boolean;
}

type TriggerFilter = "all" | "cron" | "webhook" | "recipe" | "manual" | "git_hook";
type StatusFilter =
  | "all"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

function fmtWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusPill(r: Run): "ok" | "err" | "warn" | "muted" | "running" {
  if (r.status === "running") return "running";
  if (r.assertionFailures && r.assertionFailures.length > 0) return "err";
  // Honest partial-failure: a run can finish `done` while a step errored.
  // Render amber "completed with errors" instead of a clean green "done".
  if (r.status === "done" && r.hadStepErrors) return "warn";
  if (r.status === "done") return "ok";
  if (r.status === "error") return "err";
  return "warn";
}

/** Display label for the status cell — honest about partial failure. */
function statusLabel(r: Run): string {
  if (r.status === "done" && r.hadStepErrors && !r.assertionFailures?.length) {
    return "completed with errors";
  }
  return r.status;
}

const RUNS_PAGE_SIZE = 100;

type HaltCategory =
  | "agent_silent_fail"
  | "agent_narration_only"
  | "agent_threw"
  | "tool_threw"
  | "tool_error"
  | "kill_switch"
  | "run_level"
  | "unknown";

interface HaltSummary {
  total: number;
  byCategory: Partial<Record<HaltCategory, number>>;
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

type JudgeVerdictKind = "approve" | "request_changes" | "unparseable";

interface JudgeSummary {
  total: number;
  byVerdict: Partial<Record<JudgeVerdictKind, number>>;
  recent: Array<{
    verdict: JudgeVerdictKind;
    firstReason?: string;
    runSeq: number;
    stepId: string;
  }>;
}

const JUDGE_VERDICT_LABEL: Record<JudgeVerdictKind, string> = {
  approve: "approve",
  request_changes: "request changes",
  unparseable: "unparseable",
};

const HALT_CATEGORY_LABEL: Record<HaltCategory, string> = {
  agent_silent_fail: "agent silent-fail",
  agent_narration_only: "agent narration-only",
  agent_threw: "agent threw",
  tool_threw: "tool threw",
  tool_error: "tool error",
  kill_switch: "kill-switch blocked",
  run_level: "run-level halt",
  unknown: "uncategorised",
};

type TimeWindow = "any" | "1h" | "24h" | "overnight" | "7d";

const TIME_WINDOW_LABEL: Record<TimeWindow, string> = {
  any: "Any time",
  "1h": "Last hour",
  "24h": "Last 24h",
  overnight: "Since 6pm yesterday",
  "7d": "Last 7 days",
};

function windowCutoffMs(w: TimeWindow): number | null {
  if (w === "any") return null;
  if (w === "1h") return 60 * 60 * 1000;
  if (w === "24h") return 24 * 60 * 60 * 1000;
  if (w === "7d") return 7 * 24 * 60 * 60 * 1000;
  // overnight = since 6pm of the previous calendar day in local time.
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  return Date.now() - d.getTime();
}

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [err, setErr] = useState<string>();
  // Filter state hydrated from URL on first render so refresh / share-link
  // preserves the active view. Mirrors back via history.replaceState in a
  // single effect below to avoid spamming history.
  const _initSp = typeof globalThis !== "undefined"
    ? new URLSearchParams(globalThis.location?.search ?? "")
    : new URLSearchParams();
  const _initTrigger = _initSp.get("trigger") ?? "all";
  const _initStatus = _initSp.get("status") ?? (_initSp.get("halt") === "1" ? "error" : "all");
  const _initWindow = _initSp.get("window") ?? "any";
  const [trigger, setTrigger] = useState<TriggerFilter>(
    (["all", "cron", "webhook", "recipe", "manual", "git_hook"] as const).includes(
      _initTrigger as TriggerFilter,
    )
      ? (_initTrigger as TriggerFilter)
      : "all",
  );
  const [status, setStatus] = useState<StatusFilter>(
    (["all", "running", "done", "error", "cancelled", "interrupted"] as const).includes(
      _initStatus as StatusFilter,
    )
      ? (_initStatus as StatusFilter)
      : "all",
  );
  const [window, setWindow] = useState<TimeWindow>(
    (["any", "1h", "24h", "overnight", "7d"] as const).includes(_initWindow as TimeWindow)
      ? (_initWindow as TimeWindow)
      : "any",
  );
  const [haltSummary, setHaltSummary] = useState<HaltSummary | null>(null);
  const [judgeSummary, setJudgeSummary] = useState<JudgeSummary | null>(null);
  const [recipeQuery, setRecipeQuery] = useState("");
  const debouncedRecipeQuery = useDebounced(recipeQuery, 250);
  // PR5c follow-up: read `?attempt=<id>` from URL to deep-link runs that
  // share a manualRunId. Cleared via the same "clear filters" pill.
  const searchParams = useSearchParams();
  const [attemptFilter, setAttemptFilter] = useState<string>("");
  // /sessions/[id] links to /runs?session=<id>; previously that param
  // was silently ignored. Seed a client-side filter from it (the bridge
  // /runs endpoint doesn't know about session yet, so we pass it through
  // and filter defensively on any session-shaped field on the run).
  const [sessionFilter, setSessionFilter] = useState<string>("");
  useEffect(() => {
    setAttemptFilter(searchParams?.get("attempt") ?? "");
    setSessionFilter(searchParams?.get("session") ?? "");
    // RelationStrip on /runs and the dashboard hero link to ?recipe= and
    // ?halt=1 — seed the recipe filter and (for halt=1) flip status to
    // "error" so the page actually reflects the deep-link intent.
    const r = searchParams?.get("recipe");
    if (r) setRecipeQuery(r);
    if (searchParams?.get("halt") === "1") setStatus("error");
  }, [searchParams]);
  const [limit, setLimit] = useState(RUNS_PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Mirror filter state → URL so refresh / share-link survives. Uses
  // replaceState (not router.push) so flipping filters doesn't bloat
  // the back-button history.
  useEffect(() => {
    if (typeof globalThis === "undefined" || !globalThis.location) return;
    const url = new URL(globalThis.location.href);
    const setOrDel = (k: string, v: string, def: string) => {
      if (v === def) url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    };
    setOrDel("trigger", trigger, "all");
    setOrDel("status", status, "all");
    setOrDel("window", window, "any");
    // ?halt=1 is a one-shot inbound deep-link — once we've hydrated it
    // into `status`, drop it so refresh doesn't fight the new state.
    if (url.searchParams.has("halt")) url.searchParams.delete("halt");
    globalThis.history.replaceState(null, "", url.toString());
  }, [trigger, status, window]);

  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Audit 2026-05-17 (#600): one AbortController per effect run,
    // aborted in cleanup. Without this, rapid filter changes could
    // race-overwrite the latest result with stale responses from the
    // previous filter set — user flips trigger to 'cron', sees old
    // 'manual' results blink in. The interval handle is independent;
    // the controller only cancels in-flight requests.
    const controller = new AbortController();
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (trigger !== "all") params.set("trigger", trigger);
        if (status !== "all") params.set("status", status);
        if (debouncedRecipeQuery) params.set("recipe", debouncedRecipeQuery);
        if (attemptFilter) params.set("manualRunId", attemptFilter);
        // Forward `session` to the bridge — if/when /runs grows a
        // session-axis filter the dashboard already speaks the contract.
        // Today the bridge silently ignores unknown params, and we
        // narrow client-side below.
        if (sessionFilter) params.set("session", sessionFilter);
        const res = await fetch(apiPath(`/api/bridge/runs?${params}`), {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`/runs ${res.status}`);
        const data = (await res.json()) as { runs?: Run[] };
        setRuns(data.runs ?? []);
        setErr(undefined);
      } catch (e) {
        // AbortError on unmount / dep change is expected — don't surface.
        if (e instanceof DOMException && e.name === "AbortError") return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    reloadRef.current = () => void load();
    load();
    const id = setInterval(load, 5000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [trigger, status, debouncedRecipeQuery, limit, attemptFilter, sessionFilter]);

  // Live SSE: subscribe to recipe lifecycle events (PR #642) so the list
  // updates immediately when a run starts/ends, instead of waiting up to
  // 5 s for the next poll tick. Debounced 500 ms so a burst of step events
  // from a chained recipe only triggers one reload.
  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLifecycle = (type: string, raw: unknown) => {
    if (type !== "lifecycle") return;
    const ev = (raw as { event?: string } | undefined)?.event;
    if (ev !== "recipe_started" && ev !== "recipe_done") return;
    if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    reloadDebounceRef.current = setTimeout(() => reloadRef.current(), 500);
  };
  const { connected: streamConnected } = useBridgeStream(
    "/api/bridge/stream",
    onLifecycle,
  );
  useEffect(
    () => () => {
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    },
    [],
  );

  // PR1c: poll halt-summary independently (cheaper payload, fixed cadence).
  // PR4: window selector feeds the same sinceMs into the summary so the
  // pills always reflect the same window as the displayed run list.
  useEffect(() => {
    // #600: replace the `cancelled` flag with an AbortController so we
    // actually cancel the network request on unmount / window change,
    // not just suppress the setState (which would still parse the JSON
    // and burn the bridge response).
    const controller = new AbortController();
    const load = async () => {
      try {
        const sinceMs = windowCutoffMs(window);
        const qs = sinceMs != null ? `?sinceMs=${sinceMs}` : "";
        const res = await fetch(
          apiPath(`/api/bridge/runs/halt-summary${qs}`),
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as HaltSummary;
        setHaltSummary(data);
      } catch {
        /* halt summary is best-effort; ignore */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [window]);

  // PR3b sibling poller — judge-summary on the same cadence + window.
  useEffect(() => {
    // #600: same AbortController pattern as halt-summary above.
    const controller = new AbortController();
    const load = async () => {
      try {
        const sinceMs = windowCutoffMs(window);
        const qs = sinceMs != null ? `?sinceMs=${sinceMs}` : "";
        const res = await fetch(
          apiPath(`/api/bridge/runs/judge-summary${qs}`),
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as JudgeSummary;
        setJudgeSummary(data);
      } catch {
        /* judge summary is best-effort; ignore */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [window]);

  const windowedRuns = useMemo(() => {
    if (runs == null) return null;
    const cutoffMs = windowCutoffMs(window);
    const threshold = cutoffMs == null ? null : Date.now() - cutoffMs;
    // Defensive client-side session match: the bridge run record may
    // carry the session id under one of a few field names depending on
    // version. Check all of them — typed as Run but read loosely.
    const matchesSession = (r: Run): boolean => {
      if (!sessionFilter) return true;
      const rec = r as unknown as Record<string, unknown>;
      const candidates = [
        rec.sessionId,
        rec.session,
        rec.claudeSessionId,
      ];
      return candidates.some(
        (v) => typeof v === "string" && v === sessionFilter,
      );
    };
    return runs.filter(
      (r) =>
        (threshold == null || r.createdAt >= threshold) && matchesSession(r),
    );
  }, [runs, window, sessionFilter]);

  // Reset page size when filters change so we don't accidentally hold a giant fetch.
  useEffect(() => {
    setLimit(RUNS_PAGE_SIZE);
  }, [trigger, status, debouncedRecipeQuery]);

  const stats = useMemo(() => {
    const list = windowedRuns ?? [];
    const s = { ok: 0, err: 0, running: 0, cancelled: 0, interrupted: 0, totalMs: 0 };
    for (const r of list) {
      if (r.assertionFailures && r.assertionFailures.length > 0) s.err++;
      else if (r.status === "done") s.ok++;
      else if (r.status === "error") s.err++;
      else if (r.status === "running") s.running++;
      else if (r.status === "cancelled") s.cancelled++;
      else if (r.status === "interrupted") s.interrupted++;
      s.totalMs += r.durationMs;
    }
    const avgMs = list.length ? Math.round(s.totalMs / list.length) : 0;
    return { ...s, avgMs, total: list.length };
  }, [windowedRuns]);

  const maxDur = useMemo(() => {
    if (!windowedRuns || windowedRuns.length === 0) return 1;
    return Math.max(...windowedRuns.map((r) => r.durationMs), 1);
  }, [windowedRuns]);

  // j/k row navigation through the run list — mirrors /recipes. Walks
  // windowedRuns; j → next, k → prev, wraps. Skipped while typing or
  // when no rows are visible. Sets `expanded` so the selected row also
  // reveals its detail panel (same effect as clicking the row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      const list = windowedRuns ?? [];
      if (list.length === 0) return;
      e.preventDefault();
      const idx = expanded
        ? list.findIndex((r) => `${r.taskId}-${r.seq}` === expanded)
        : -1;
      const delta = e.key === "j" ? 1 : -1;
      const next =
        idx === -1
          ? e.key === "j"
            ? 0
            : list.length - 1
          : (idx + delta + list.length) % list.length;
      const nextKey = `${list[next].taskId}-${list[next].seq}`;
      setExpanded(nextKey);
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-run-row="${CSS.escape(nextKey)}"]`,
        );
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        // Move real DOM focus so keyboard + screen-reader users get
        // feedback from j/k, not just a visual selection change.
        row?.focus();
      });
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [windowedRuns, expanded]);

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Runs — <span className="accent">every patch your agents stitched.</span>
          </h1>
          <div className="editorial-sub">
            {runs ? `${runs.length} runs` : "— runs"} · {TIME_WINDOW_LABEL[window].toLowerCase()} · avg {fmtDur(stats.avgMs)}
            {/* Statuses without dedicated stat cards (running / cancelled /
                interrupted) surface here as inline filter links so they're
                still reachable from the UI. Hidden when zero. */}
            {(["running", "cancelled", "interrupted"] as const).map((k) =>
              stats[k] > 0 ? (
                <span key={k}>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => setStatus(k)}
                    title={`Filter to ${k} runs`}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--accent)",
                      cursor: "pointer",
                      font: "inherit",
                      padding: 0,
                      textDecoration: "underline",
                    }}
                  >
                    {stats[k]} {k}
                  </button>
                </span>
              ) : null,
            )}
          </div>
          <RelationStrip
            items={[
              { label: "Recipes", href: "/recipes", title: "The YAML that produced these runs" },
              { label: "Halts", href: "/runs?halt=1", tone: "warn", title: "Runs that hit a halt reason" },
              { label: "Traces", href: "/traces", title: "Decision logs for these runs" },
              { label: "Activity", href: "/activity", title: "Live event firehose" },
            ]}
          />
        </div>
        <LivePill connection={streamConnected ? "live" : "reconnecting"} />
      </div>

      {haltSummary && haltSummary.total > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: "var(--s-4)",
            padding: "8px 12px",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            background: "var(--bg-0)",
          }}
          title={
            haltSummary.recent
              .map((r) => `run #${r.runSeq}: ${r.reason}`)
              .join("\n") || undefined
          }
        >
          <span className="mono muted" style={{ fontSize: "var(--fs-xs)" }}>
            halts ({TIME_WINDOW_LABEL[window].toLowerCase()}): {haltSummary.total}
          </span>
          {(
            Object.entries(haltSummary.byCategory) as Array<
              [HaltCategory, number]
            >
          )
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => (
              <button
                key={cat}
                type="button"
                className="pill"
                onClick={() => setStatus("error")}
                aria-label={`Filter to errored runs (${HALT_CATEGORY_LABEL[cat]} · ${count})`}
                title="Click to filter list to errored runs"
                style={{
                  fontSize: "var(--fs-2xs)",
                  background: cat === "unknown" ? "var(--bg-1)" : undefined,
                  color: cat === "unknown" ? "var(--fg-2)" : "var(--err)",
                  ...(cat === "unknown" && {
                    border: "1px solid var(--border-subtle)",
                  }),
                  cursor: "pointer",
                  font: "inherit",
                  minHeight: 24,
                }}
              >
                {HALT_CATEGORY_LABEL[cat]} · {count}
              </button>
            ))}
        </div>
      )}

      {judgeSummary && judgeSummary.total > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: "var(--s-4)",
            padding: "8px 12px",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            background: "var(--bg-0)",
          }}
          title={
            judgeSummary.recent
              .map(
                (r) =>
                  `run #${r.runSeq} · ${r.stepId}: [${r.verdict}] ${r.firstReason ?? ""}`,
              )
              .join("\n") || undefined
          }
        >
          <span className="mono muted" style={{ fontSize: "var(--fs-xs)" }}>
            judgments: {judgeSummary.total}
          </span>
          {(
            Object.entries(judgeSummary.byVerdict) as Array<
              [JudgeVerdictKind, number]
            >
          )
            .sort((a, b) => b[1] - a[1])
            .map(([verdict, count]) => (
              <span
                key={verdict}
                className="pill"
                style={{
                  fontSize: "var(--fs-2xs)",
                  color:
                    verdict === "approve"
                      ? "var(--ok)"
                      : verdict === "request_changes"
                        ? "var(--warn, #d49a3a)"
                        : "var(--fg-2)",
                  ...(verdict === "unparseable" && {
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-1)",
                  }),
                }}
              >
                {JUDGE_VERDICT_LABEL[verdict]} · {count}
              </span>
            ))}
        </div>
      )}

      {/* filter bar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: "var(--s-4)",
        }}
      >
        <input
          type="text"
          value={recipeQuery}
          onChange={(e) => setRecipeQuery(e.target.value)}
          placeholder="Filter by recipe…"
          aria-label="Filter by recipe"
          className="input"
          style={{ minWidth: "min(200px, 100%)", width: 240, maxWidth: "100%" }}
        />
        <select
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as TriggerFilter)}
          aria-label="Trigger type"
          className="input"
          style={{ width: "auto", cursor: "pointer" }}
        >
          <option value="all">All triggers</option>
          <option value="cron">Cron</option>
          <option value="webhook">Webhook</option>
          <option value="recipe">Recipe</option>
          <option value="manual">Manual</option>
          <option value="git_hook">Git hook</option>
        </select>
        <select
          value={window}
          onChange={(e) => setWindow(e.target.value as TimeWindow)}
          aria-label="Time window"
          className="input"
          style={{ width: "auto", cursor: "pointer" }}
        >
          {(Object.keys(TIME_WINDOW_LABEL) as TimeWindow[]).map((w) => (
            <option key={w} value={w}>
              {TIME_WINDOW_LABEL[w]}
            </option>
          ))}
        </select>
        {attemptFilter && (
          <span
            className="pill mono"
            style={{ fontSize: "var(--fs-xs)" }}
            title="Filtering by attempt id"
          >
            attempt:{attemptFilter}
          </span>
        )}
        {sessionFilter && (
          <span
            className="pill mono"
            style={{ fontSize: "var(--fs-xs)" }}
            title={`Filtering to runs in session ${sessionFilter}`}
          >
            session:{sessionFilter.slice(0, 8)}
          </span>
        )}
        {(recipeQuery ||
          trigger !== "all" ||
          window !== "any" ||
          attemptFilter ||
          sessionFilter) && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setRecipeQuery("");
              setTrigger("all");
              setWindow("any");
              setAttemptFilter("");
              setSessionFilter("");
              // Strip the ?attempt= from the URL so the filter doesn't
              // re-apply on next render via the useSearchParams effect.
              // `window` is shadowed by a state variable in this file —
              // reach the global through `globalThis`.
              const g = globalThis as typeof globalThis & {
                window?: Window;
              };
              if (g.window) {
                const url = new URL(g.window.location.href);
                let dirty = false;
                for (const k of ["attempt", "recipe", "halt", "session"]) {
                  if (url.searchParams.has(k)) {
                    url.searchParams.delete(k);
                    dirty = true;
                  }
                }
                if (dirty) g.window.history.replaceState({}, "", url.toString());
              }
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--s-4)", marginBottom: "var(--s-5)" }}>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("all")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: `3px solid ${status === "all" ? "var(--orange)" : "var(--line-2)"}`,
            cursor: "pointer",
            background: "transparent",
          }}
          aria-pressed={status === "all"}
          aria-label={`Filter: all runs (${stats.total})`}
        >
          <div style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginBottom: 8 }}>All runs</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}><AnimatedNumber value={stats.total} /></div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>Last 24h</div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("done")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: `3px solid ${status === "done" ? "var(--ok)" : "var(--line-2)"}`,
            cursor: "pointer",
            background: "transparent",
          }}
          aria-pressed={status === "done"}
          aria-label={`Filter: successful runs (${stats.ok})`}
        >
          <div style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ok)", marginBottom: 8 }}>✓ Successful</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}><AnimatedNumber value={stats.ok} /></div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>{stats.total > 0 ? Math.round(stats.ok / stats.total * 100) + "%" : "—"} success rate</div>
        </button>
        <button
          type="button"
          className="card"
          onClick={() => setStatus("error")}
          style={{
            textAlign: "left",
            padding: "20px 24px",
            borderLeft: `3px solid ${status === "error" ? "var(--err)" : "var(--line-2)"}`,
            cursor: "pointer",
            background: "transparent",
          }}
          aria-pressed={status === "error"}
          aria-label={`Filter: errored runs (${stats.err})`}
        >
          <div style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--err)", marginBottom: 8 }}>⚠ Errored</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 36, fontWeight: 800, color: stats.err > 0 ? "var(--err)" : "var(--ink-0)", lineHeight: 1 }}><AnimatedNumber value={stats.err} /></div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>{stats.total > 0 ? Math.round(stats.err / stats.total * 100) + "%" : "—"} error rate</div>
        </button>
      </div>

      {err && (!runs || runs.length === 0) && (
        <ErrorState
          title="Couldn't load runs"
          description="The bridge isn't responding to /runs."
          error={err}
          onRetry={() => reloadRef.current()}
        />
      )}
      {err && runs && runs.length > 0 && (
        <div className="alert-err">Refresh failed — {err}</div>
      )}

      {windowedRuns === null && !err ? (
        <SkeletonList rows={6} columns={6} />
      ) : !windowedRuns || windowedRuns.length === 0 ? (
        (() => {
          const filtered =
            trigger !== "all" ||
            status !== "all" ||
            !!debouncedRecipeQuery ||
            !!attemptFilter ||
            !!sessionFilter;
          return (
            <EmptyState
              title={
                filtered
                  ? "No runs match current filters"
                  : window === "any"
                    ? "No runs yet"
                    : "No runs in this window"
              }
              description={
                filtered ? (
                  <>
                    Active:{" "}
                    {[
                      trigger !== "all" && `trigger=${trigger}`,
                      status !== "all" && `status=${status}`,
                      debouncedRecipeQuery && `recipe=${debouncedRecipeQuery}`,
                      attemptFilter && `attempt=${attemptFilter}`,
                      sessionFilter && `session=${sessionFilter}`,
                      window !== "any" &&
                        `window=${TIME_WINDOW_LABEL[window].toLowerCase()}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </>
                ) : window === "any" ? (
                  <>
                    Recipe executions (cron, webhook, or{" "}
                    <code>patchwork recipe run</code>) will appear here once
                    they complete.
                  </>
                ) : (
                  <>
                    No runs in “{TIME_WINDOW_LABEL[window]}”. Try widening
                    the window.
                  </>
                )
              }
              action={
                filtered ? (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      setTrigger("all");
                      setStatus("all");
                      setRecipeQuery("");
                      setAttemptFilter("");
                      setSessionFilter("");
                    }}
                  >
                    Clear filters
                  </button>
                ) : undefined
              }
            />
          );
        })()
      ) : (
        <>
        {/* Desktop / tablet: dense multi-column table. Hidden ≤768px. */}
        <div className="table-wrap runs-table-desktop">
          <table className="table" aria-keyshortcuts="j k">
            <thead>
              <tr>
                <th style={{ width: 120 }}>When</th>
                <th>Recipe</th>
                <th style={{ width: 90 }}>Trigger</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 200, textAlign: "right" }}>Duration</th>
                <th style={{ width: 80 }}>Task</th>
              </tr>
            </thead>
            <tbody>
              {windowedRuns.map((r) => {
                const key = `${r.taskId}-${r.seq}`;
                const isExpanded = expanded === key;
                const pct = Math.max(
                  3,
                  Math.round((r.durationMs / maxDur) * 100),
                );
                const sClass = statusPill(r);
                const barColor =
                  sClass === "ok"
                    ? "var(--green)"
                    : sClass === "err"
                      ? "var(--red)"
                      : "var(--amber)";
                return (
                  <React.Fragment key={key}>
                    <tr
                      data-run-row={key}
                      onClick={() => setExpanded(isExpanded ? null : key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpanded(isExpanded ? null : key);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isExpanded}
                      aria-label={`Run of ${formatRecipeName(r.recipeName, r.trigger)}, ${statusLabel(r)}, ${normaliseTrigger(r.trigger)} trigger`}
                      style={{
                        cursor: "pointer",
                        boxShadow:
                          r.status === "running"
                            ? "inset 3px 0 0 var(--blue)"
                            : undefined,
                      }}
                    >
                      <td className="mono muted">
                        {fmtWhen(
                          r.status === "running"
                            ? r.startedAt ?? r.createdAt
                            : r.doneAt,
                        )}
                      </td>
                      <td className="mono">
                        <Link
                          href={`/runs/${r.seq}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontWeight: 600 }}
                        >
                          {formatRecipeName(r.recipeName, r.trigger)}
                        </Link>
                      </td>
                      <td>
                        <span className="pill muted">{normaliseTrigger(r.trigger)}</span>
                        {r.manualRunId && (
                          <Link
                            href={`/runs?attempt=${encodeURIComponent(r.manualRunId)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="pill muted mono"
                            style={{
                              marginLeft: 6,
                              fontSize: "var(--fs-2xs)",
                              textDecoration: "none",
                            }}
                            title={`Attempt id ${r.manualRunId} — click to filter to all runs sharing this attempt`}
                          >
                            attempt:{r.manualRunId.slice(-6)}
                          </Link>
                        )}
                      </td>
                      <td>
                        <span
                          className={`pill ${sClass}`}
                          style={{ fontSize: "var(--fs-xs)" }}
                        >
                          {sClass !== "running" && (
                            <span className="pill-dot" />
                          )}
                          {statusLabel(r)}
                          {r.assertionFailures &&
                            r.assertionFailures.length > 0 &&
                            ` · ${r.assertionFailures.length} fail`}
                        </span>
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <div
                            className="progress"
                            style={{ flex: 1, height: 6 }}
                          >
                            <div
                              className="progress-fill"
                              style={{
                                width: r.status === "running" ? "100%" : `${pct}%`,
                                background: barColor,
                                opacity: r.status === "running" ? 0.4 : 1,
                              }}
                            />
                          </div>
                          <span
                            className="mono"
                            style={{
                              fontSize: "var(--fs-xs)",
                              color: "var(--ink-2)",
                              minWidth: 42,
                              textAlign: "right",
                            }}
                          >
                            {r.status === "running"
                              ? fmtDur(Date.now() - (r.startedAt ?? r.createdAt))
                              : fmtDur(r.durationMs)}
                          </span>
                        </div>
                      </td>
                      <td className="mono muted" title={r.taskId ?? undefined}>
                        {r.taskId?.slice(0, 8) ?? "—"}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${key}-detail`} className="task-row-expand">
                        <td colSpan={6}>
                          <div
                            style={{
                              padding: "12px 14px",
                              fontSize: "var(--fs-s)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                gap: 16,
                                flexWrap: "wrap",
                                color: "var(--ink-2)",
                              }}
                            >
                              {r.model && (
                                <span>
                                  Model{" "}
                                  <span className="mono" style={{ color: "var(--ink-0)" }}>
                                    {r.model}
                                  </span>
                                </span>
                              )}
                              <span>
                                Created{" "}
                                <span
                                  className="mono"
                                  style={{ color: "var(--ink-0)" }}
                                >
                                  {new Date(r.createdAt).toISOString()}
                                </span>
                              </span>
                            </div>
                            {r.errorMessage && (
                              <div>
                                <div
                                  style={{
                                    fontSize: "var(--fs-2xs)",
                                    color: "var(--red)",
                                    fontWeight: 600,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                    marginBottom: 4,
                                  }}
                                >
                                  Error
                                </div>
                                <pre
                                  className="task-output"
                                  style={{ color: "var(--red)" }}
                                >
                                  {r.errorMessage}
                                </pre>
                              </div>
                            )}
                            {r.assertionFailures &&
                              r.assertionFailures.length > 0 && (
                                <div>
                                  <div
                                    style={{
                                      fontSize: "var(--fs-2xs)",
                                      color: "var(--red)",
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.06em",
                                      marginBottom: 4,
                                    }}
                                  >
                                    {r.assertionFailures.length} assertion
                                    failure
                                    {r.assertionFailures.length !== 1 ? "s" : ""}
                                  </div>
                                  <ul
                                    style={{
                                      margin: 0,
                                      paddingLeft: 20,
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 3,
                                    }}
                                  >
                                    {r.assertionFailures.map((f, i) => (
                                      <li
                                        key={i}
                                        style={{
                                          fontSize: "var(--fs-s)",
                                          color: "var(--red)",
                                        }}
                                      >
                                        <span
                                          className="mono"
                                          style={{ fontWeight: 600 }}
                                        >
                                          {f.assertion}
                                        </span>
                                        {" — "}
                                        {f.message}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            {r.outputTail && (
                              <div>
                                <div
                                  style={{
                                    fontSize: "var(--fs-2xs)",
                                    color: "var(--ink-2)",
                                    fontWeight: 600,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                    marginBottom: 4,
                                  }}
                                >
                                  Output tail
                                </div>
                                <pre className="task-output">{r.outputTail}</pre>
                              </div>
                            )}
                            <div>
                              <Link
                                href={`/runs/${r.seq}`}
                                className="btn sm ghost"
                                style={{ textDecoration: "none" }}
                              >
                                Open full run →
                              </Link>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {runs != null &&
            runs.length >= limit &&
            // When the time-window selector trims the unfiltered fetch, the
            // user has already paged past the binding constraint — fetching
            // more from the server only returns runs older than the window,
            // which are then filtered out. Hide the button to avoid a no-op
            // network request.
            (windowedRuns == null || windowedRuns.length === runs.length) && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "var(--s-4) 0",
              }}
            >
              <button
                type="button"
                className="btn ghost"
                onClick={() => setLimit((n) => n + RUNS_PAGE_SIZE)}
              >
                Load more (+{RUNS_PAGE_SIZE})
              </button>
            </div>
          )}
        </div>

        {/* Mobile (≤768px): stacked card layout. The dense table is
            unreadable crammed into a phone viewport, so each run becomes
            a tappable card. Shown only ≤768px via .runs-card-list CSS. */}
        <div className="runs-card-list">
          {windowedRuns.map((r) => {
            const key = `${r.taskId}-${r.seq}`;
            const isExpanded = expanded === key;
            const sClass = statusPill(r);
            return (
              <div
                key={key}
                data-run-row={key}
                className="run-card"
                data-status={r.status}
                onClick={() => setExpanded(isExpanded ? null : key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpanded(isExpanded ? null : key);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-expanded={isExpanded}
              >
                <div className="run-card-head">
                  <Link
                    href={`/runs/${r.seq}`}
                    onClick={(e) => e.stopPropagation()}
                    className="mono"
                    style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {formatRecipeName(r.recipeName, r.trigger)}
                  </Link>
                  <span
                    className={`pill ${sClass}`}
                    style={{ fontSize: "var(--fs-2xs)", flexShrink: 0 }}
                  >
                    {sClass !== "running" && <span className="pill-dot" />}
                    {statusLabel(r)}
                    {r.assertionFailures &&
                      r.assertionFailures.length > 0 &&
                      ` · ${r.assertionFailures.length} fail`}
                  </span>
                </div>
                <div className="run-card-meta">
                  <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }}>
                    {normaliseTrigger(r.trigger)}
                  </span>
                  <span className="mono muted">
                    {fmtWhen(
                      r.status === "running"
                        ? r.startedAt ?? r.createdAt
                        : r.doneAt,
                    )}
                  </span>
                  <span className="mono muted">
                    {r.status === "running"
                      ? fmtDur(Date.now() - (r.startedAt ?? r.createdAt))
                      : fmtDur(r.durationMs)}
                  </span>
                  {r.taskId && (
                    <span className="mono muted" title={r.taskId}>
                      {r.taskId.slice(0, 8)}
                    </span>
                  )}
                </div>
                {isExpanded && (
                  <div className="run-card-detail">
                    {r.errorMessage && (
                      <pre className="task-output" style={{ color: "var(--red)" }}>
                        {r.errorMessage}
                      </pre>
                    )}
                    {r.outputTail && (
                      <pre className="task-output">{r.outputTail}</pre>
                    )}
                    <Link
                      href={`/runs/${r.seq}`}
                      className="btn sm ghost"
                      style={{ textDecoration: "none" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open full run →
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
          {runs != null &&
            runs.length >= limit &&
            (windowedRuns == null ||
              windowedRuns.length === runs.length) && (
              <button
                type="button"
                className="btn ghost"
                style={{ alignSelf: "center", marginTop: "var(--s-3)" }}
                onClick={() => setLimit((n) => n + RUNS_PAGE_SIZE)}
              >
                Load more (+{RUNS_PAGE_SIZE})
              </button>
            )}
        </div>
        </>
      )}
    </section>
  );
}
