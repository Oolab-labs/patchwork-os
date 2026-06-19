"use client";
import React from "react";
import { apiPath } from "@/lib/api";
import { deriveRunStatus } from "@/components/patchwork/StatusPill";
import { HALT_CATEGORY_HINT, HALT_CATEGORY_LABEL } from "@/lib/haltCategory";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LivePill } from "@/components/patchwork/LivePill";
import { AnimatedNumber, EmptyState, ErrorState, RelationStrip } from "@/components/patchwork";
import { RecipeChip } from "@/components/patchwork/entity";
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
  if (t.startsWith("file_watch") || t.startsWith("on_file_save")) return "file_watch";
  if (t.startsWith("on_test_run") || t.startsWith("test_run")) return "on_test_run";
  return "manual";
}

function triggerPillClass(t: string): string {
  const norm = normaliseTrigger(t);
  if (norm === "cron") return "accent";
  if (norm === "webhook") return "info";
  if (norm === "git_hook") return "ok";
  if (norm === "file_watch") return "warn";
  if (norm === "on_test_run") return "purp";
  return "muted";
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
  if (ms < 60_000) {
    const s = Math.floor(ms / 1000);
    const rem = ms % 1000;
    return rem === 0 ? `${s}s` : `${s}.${String(Math.floor(rem / 100))}s`;
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Runs-list status view, derived from the shared `deriveRunStatus` so the
 * list cell and the run-detail header render one verdict from one place
 * (facelift P0-3-C). `running` keeps its dedicated pill class so
 * `.pill.running::before` draws the pulse dot (no inline JSX dot). The
 * returned label already folds in assertion failures ("error · N fail") and
 * partial failures ("completed with errors") — callers render it verbatim.
 */
function runStatusView(r: Run): { cls: string; label: string } {
  if (r.status === "running") return { cls: "running", label: "running" };
  const { tone, label } = deriveRunStatus(r.status, {
    hadStepErrors: r.hadStepErrors,
    assertionFailures: r.assertionFailures?.length ?? 0,
  });
  // deriveRunStatus only yields "info" for running (handled above); ok/err/warn
  // map 1:1 to pill tone classes, anything else falls back to muted.
  const cls = tone === "ok" || tone === "err" || tone === "warn" ? tone : "muted";
  return { cls, label };
}

const RUNS_PAGE_SIZE = 100;

type HaltCategory = import("@/lib/haltCategory").HaltCategory;
type HaltSummary = import("@/lib/haltCategory").HaltSummary;

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
    let finishedCount = 0;
    for (const r of list) {
      if (r.assertionFailures && r.assertionFailures.length > 0) s.err++;
      else if (r.status === "done") s.ok++;
      else if (r.status === "error") s.err++;
      else if (r.status === "running") s.running++;
      else if (r.status === "cancelled") s.cancelled++;
      else if (r.status === "interrupted") s.interrupted++;
      // M9: only include finished runs in avg — running jobs have durationMs=0
      if (r.status !== "running") {
        s.totalMs += r.durationMs;
        finishedCount++;
      }
    }
    const avgMs = finishedCount > 0 ? Math.round(s.totalMs / finishedCount) : 0;
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
            {/* Editorial tagline only when there's no data to speak for itself;
                once runs are loaded the factual subtitle below carries the
                context, so the header stays operational (facelift P2-8-A). */}
            Runs
            {(!runs || runs.length === 0) && (
              <>
                {" — "}
                <span className="accent">every patch your agents stitched.</span>
              </>
            )}
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
                    className="btn-inline"
                    onClick={() => setStatus(k)}
                    title={`Filter to ${k} runs`}
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
              // Only tint the Halts chip when halts actually exist; otherwise
              // it sits ghost-neutral like its siblings (facelift P3-12).
              { label: "Halts", href: "/runs?halt=1", tone: (haltSummary?.total ?? 0) > 0 ? "err" : undefined, title: "Runs that hit a halt reason" },
              { label: "Traces", href: "/traces", title: "Decision logs for these runs" },
              { label: "Activity", href: "/activity", title: "Live event firehose" },
            ]}
          />
        </div>
        <LivePill connection={streamConnected ? "live" : "reconnecting"} />
      </div>

      {haltSummary && haltSummary.total > 0 && (
        <div
          className="runs-summary-band"
          title={
            haltSummary.recent
              .map((r) => `run #${r.runSeq}: ${r.reason}`)
              .join("\n") || undefined
          }
        >
          <span className="mono muted runs-summary-band-label">
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
                className="pill runs-halt-pill runs-filter-chip-btn"
                data-cat={cat}
                onClick={() => setStatus("error")}
                aria-label={`Filter to errored runs (${HALT_CATEGORY_LABEL[cat]} · ${count}) — ${HALT_CATEGORY_HINT[cat]}`}
                title={`${HALT_CATEGORY_HINT[cat]}\n\nClick to filter list to errored runs.`}
              >
                {HALT_CATEGORY_LABEL[cat]} · {count}
              </button>
            ))}
        </div>
      )}

      {judgeSummary && judgeSummary.total > 0 && (
        <div
          className="runs-summary-band"
          title={
            judgeSummary.recent
              .map(
                (r) =>
                  `run #${r.runSeq} · ${r.stepId}: [${r.verdict}] ${r.firstReason ?? ""}`,
              )
              .join("\n") || undefined
          }
        >
          <span className="mono muted runs-summary-band-label">
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
                className="pill runs-judge-pill"
                data-verdict={verdict}
              >
                {JUDGE_VERDICT_LABEL[verdict]} · {count}
              </span>
            ))}
        </div>
      )}

      {/* filter bar */}
      <div className="runs-filter-bar">
        <input
          type="text"
          value={recipeQuery}
          onChange={(e) => setRecipeQuery(e.target.value)}
          placeholder="Filter by recipe…"
          aria-label="Filter by recipe"
          className="input runs-search-input"
        />
        <select
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as TriggerFilter)}
          aria-label="Trigger type"
          className="input runs-select"
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
          className="input runs-select"
        >
          {(Object.keys(TIME_WINDOW_LABEL) as TimeWindow[]).map((w) => (
            <option key={w} value={w}>
              {TIME_WINDOW_LABEL[w]}
            </option>
          ))}
        </select>
        {attemptFilter && (
          <span
            className="pill mono xs"
            title="Filtering by attempt id"
          >
            attempt:{attemptFilter}
          </span>
        )}
        {sessionFilter && (
          <span
            className="pill mono xs"
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
            className="btn sm ghost runs-filter-chip-btn"
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
      <div className="runs-stat-grid">
        <button
          type="button"
          className="card runs-stat-card"
          data-variant="all"
          data-active={status === "all" ? "true" : undefined}
          onClick={() => setStatus("all")}
          aria-pressed={status === "all"}
          aria-label={`Filter: all runs (${stats.total})`}
        >
          <div className="runs-stat-label">All runs</div>
          <div className="runs-stat-value"><AnimatedNumber value={stats.total} /></div>
          <div className="runs-stat-foot">{TIME_WINDOW_LABEL[window]}</div>
        </button>
        <button
          type="button"
          className="card runs-stat-card"
          data-variant="done"
          data-active={status === "done" ? "true" : undefined}
          onClick={() => setStatus("done")}
          aria-pressed={status === "done"}
          aria-label={`Filter: successful runs (${stats.ok})`}
        >
          <div className="runs-stat-label runs-stat-label--ok">✓ Successful</div>
          <div className="runs-stat-value"><AnimatedNumber value={stats.ok} /></div>
          <div className="runs-stat-foot">{stats.total > 0 ? Math.round(stats.ok / stats.total * 100) + "%" : "—"} success rate</div>
        </button>
        <button
          type="button"
          className="card runs-stat-card"
          data-variant="error"
          data-active={status === "error" ? "true" : undefined}
          onClick={() => setStatus("error")}
          aria-pressed={status === "error"}
          aria-label={`Filter: errored runs (${stats.err})`}
        >
          <div className="runs-stat-label runs-stat-label--err">✗ Errored</div>
          <div className={`runs-stat-value${stats.err > 0 ? " runs-stat-value--err" : ""}`}><AnimatedNumber value={stats.err} /></div>
          <div className="runs-stat-foot">{stats.total > 0 ? Math.round(stats.err / stats.total * 100) + "%" : "—"} error rate</div>
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
                    No runs in &ldquo;{TIME_WINDOW_LABEL[window]}&rdquo;. Try widening
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
                ) : (
                  <Link href="/recipes" className="btn sm">
                    Go to recipes →
                  </Link>
                )
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
                <th>When</th>
                <th>Recipe</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody>
              {windowedRuns.map((r, rowIdx) => {
                const key = `${r.taskId}-${r.seq}`;
                const isExpanded = expanded === key;
                const pct = Math.max(
                  3,
                  Math.round((r.durationMs / maxDur) * 100),
                );
                const { cls: sClass, label: sLabel } = runStatusView(r);
                const barColor =
                  sClass === "ok"
                    ? "var(--green)"
                    : sClass === "err"
                      ? "var(--red)"
                      : "var(--amber)";
                const isFailure = r.status === "error" || (r.assertionFailures && r.assertionFailures.length > 0);
                return (
                  <React.Fragment key={key}>
                    <tr
                      data-run-row={key}
                      data-status={r.status}
                      className={`runs-tr runs-stagger-row${isFailure ? " runs-tr--failure" : ""}`}
                      style={{ animationDelay: `${Math.min(rowIdx * 30, 400)}ms` }}
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
                      aria-label={`Run of ${formatRecipeName(r.recipeName, r.trigger)}, ${sLabel}, ${normaliseTrigger(r.trigger)} trigger`}
                    >
                      <td className="mono muted">
                        {fmtWhen(
                          r.status === "running"
                            ? r.startedAt ?? r.createdAt
                            : r.doneAt,
                        )}
                      </td>
                      <td className="mono">
                        {/* Chip links to the recipe hub; row click still
                            expands; row-level "Open full run →" in the
                            drawer handles the run navigation. */}
                        <span
                          className="runs-chip-wrap"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <RecipeChip
                            name={r.recipeName}
                            trigger={normaliseTrigger(r.trigger)}
                            variant="row"
                          />
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${triggerPillClass(r.trigger)}`}>{normaliseTrigger(r.trigger)}</span>
                        {r.manualRunId && (
                          <Link
                            href={`/runs?attempt=${encodeURIComponent(r.manualRunId)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="pill muted mono runs-attempt-pill"
                            title={`Attempt id ${r.manualRunId} — click to filter to all runs sharing this attempt`}
                          >
                            attempt:{r.manualRunId.slice(-6)}
                          </Link>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${sClass} runs-status-pill`}>
                          {/* Running pills draw their pulse dot via
                              `.pill.running::before`; only non-running pills
                              need the static dot (facelift P0-3-B). */}
                          {sClass !== "running" && <span className="pill-dot" />}
                          {sLabel}
                        </span>
                      </td>
                      <td
                        aria-label={`Duration ${
                          r.status === "running"
                            ? fmtDur(Date.now() - (r.startedAt ?? r.createdAt))
                            : fmtDur(r.durationMs)
                        }, status: ${sLabel}`}
                      >
                        <div className="runs-dur-cell">
                          <div className="progress runs-dur-bar" aria-hidden="true">
                            <div
                              className="progress-fill"
                              style={{
                                width: r.status === "running" ? "100%" : `${pct}%`,
                                background: barColor,
                                opacity: r.status === "running" ? 0.4 : 1,
                              }}
                            />
                          </div>
                          <span className="mono runs-dur-text">
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
                          <div className="run-expand-body">
                            <div className="run-expand-meta">
                              {r.model && (
                                <span>
                                  Model{" "}
                                  <span className="mono run-expand-mono">{r.model}</span>
                                </span>
                              )}
                              <span>
                                Created{" "}
                                <span className="mono run-expand-mono">
                                  {new Date(r.createdAt).toISOString()}
                                </span>
                              </span>
                            </div>
                            {r.errorMessage && (
                              <div
                                style={{
                                  borderLeft: "3px solid var(--err)",
                                  paddingLeft: 12,
                                  borderRadius: "0 var(--radius) var(--radius) 0",
                                  background: "color-mix(in oklch, var(--err) 6%, var(--card-bg))",
                                  padding: "10px 12px",
                                  marginBottom: 8,
                                }}
                              >
                                <div className="run-expand-section-label run-expand-section-label--err" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontSize: "1.1em" }}>⚠</span> Error
                                </div>
                                <pre className="task-output task-output--err">
                                  {r.errorMessage}
                                </pre>
                              </div>
                            )}
                            {r.assertionFailures &&
                              r.assertionFailures.length > 0 && (
                                <div>
                                  <div className="run-expand-section-label run-expand-section-label--err">
                                    {r.assertionFailures.length} assertion
                                    failure
                                    {r.assertionFailures.length !== 1 ? "s" : ""}
                                  </div>
                                  <ul className="run-expand-assertions">
                                    {r.assertionFailures.map((f, i) => (
                                      <li
                                        // biome-ignore lint/suspicious/noArrayIndexKey: assertion order is stable
                                        key={i}
                                        className="run-expand-assertion"
                                      >
                                        <span className="mono run-expand-assertion-key">
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
                                <div className="run-expand-section-label run-expand-section-label--out">
                                  Output tail
                                </div>
                                <pre className="task-output">{r.outputTail}</pre>
                              </div>
                            )}
                            <div>
                              <Link
                                href={`/runs/${r.seq}`}
                                className="btn sm ghost"
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
            <div className="runs-load-more">
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
          {windowedRuns.map((r, rowIdx) => {
            const key = `${r.taskId}-${r.seq}`;
            const isExpanded = expanded === key;
            const { cls: sClass, label: sLabel } = runStatusView(r);
            return (
              <div
                key={key}
                data-run-row={key}
                className="run-card runs-stagger-row"
                data-status={r.status}
                style={{ animationDelay: `${Math.min(rowIdx * 30, 400)}ms` }}
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
                  <span
                    className="runs-chip-wrap-mobile"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <RecipeChip
                      name={r.recipeName}
                      trigger={normaliseTrigger(r.trigger)}
                      variant="row"
                    />
                  </span>
                  <span className={`pill ${sClass} xs`}>
                    {/* Running pills draw their pulse dot via
                        `.pill.running::before` (facelift P0-3-B). */}
                    {sClass !== "running" && <span className="pill-dot" />}
                    {sLabel}
                  </span>
                </div>
                <div className="run-card-meta">
                  <span className={`pill ${triggerPillClass(r.trigger)} xs`}>
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
                      <pre className="task-output task-output--err">
                        {r.errorMessage}
                      </pre>
                    )}
                    {r.outputTail && (
                      <pre className="task-output">{r.outputTail}</pre>
                    )}
                    <Link
                      href={`/runs/${r.seq}`}
                      className="btn sm ghost"
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
                className="btn ghost runs-card-load-more"
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
