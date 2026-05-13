"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiPath } from "@/lib/api";
import { relTime } from "@/components/time";
import { ACTIVITY_NOISE_EVENTS } from "@/lib/activityNoise";
import { isDemoMode } from "@/lib/demoMode";
import {
  EmptyState,
  EventsHistogram,
  HBarList,
  HintCard,
  LivePill,
  type LivePillConnection,
} from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { ActivityTabs } from "@/components/ActivityTabs";
import { RecentHaltsPanel } from "@/components/RecentHaltsPanel";

const TABS: readonly Tab[] = ["all", "tools", "recipe_start", "recipe_end"];
function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

type Tab = "all" | "tools" | "recipe_start" | "recipe_end";

interface ActivityEvent {
  /** "tool" | "lifecycle" */
  kind: string;
  /** Tool name (only on kind="tool"). */
  tool?: string;
  status?: "success" | "error";
  durationMs?: number;
  errorMessage?: string;
  /** ISO 8601 timestamp from the bridge (both history + live stream). */
  timestamp?: string;
  /** Derived ms epoch, set by parse. */
  at?: number;
  id?: number;
  /** Lifecycle-only: the event name (extension_connected, approval_decision, …). */
  event?: string;
  /** Lifecycle-only: free-form metadata bag. */
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function getLifecycleMeta(e: ActivityEvent) {
  const m = e.metadata ?? {};
  // recipeName lives in metadata for both lifecycle rows AND tool-call
  // rows the bridge emits inside a recipe step. Surfacing it on the row
  // lets users trace tool calls back to the recipe that produced them
  // without bouncing through /runs.
  const rawRecipe =
    typeof m.recipeName === "string"
      ? m.recipeName
      : typeof m.recipe === "string"
        ? m.recipe
        : undefined;
  return {
    toolName: typeof m.toolName === "string" ? m.toolName : undefined,
    decision: typeof m.decision === "string" ? m.decision : undefined,
    reason: typeof m.reason === "string" ? m.reason : undefined,
    specifier: typeof m.specifier === "string" ? m.specifier : undefined,
    sessionId:
      typeof m.sessionId === "string" ? m.sessionId.slice(0, 8) : undefined,
    summary: typeof m.summary === "string" ? m.summary : undefined,
    recipeName: rawRecipe ? rawRecipe.replace(/:agent$/, "") : undefined,
  };
}

const MAX_EVENTS = 200;

const RECIPE_START_EVENTS = new Set(["recipe_step_start", "TaskCreated", "InstructionsLoaded", "session_start"]);
const RECIPE_END_EVENTS = new Set(["recipe_step_done", "recipe_done", "PostCompact", "session_end", "recipe_end"]);

function withAt(e: ActivityEvent): ActivityEvent {
  if (typeof e.at === "number") return e;
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return { ...e, at: ms };
  }
  return e;
}


export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [seeded, setSeeded] = useState(false);
  // Tri-state: "reconnecting" while EventSource is opening or has errored
  // and is auto-retrying; "live" once onopen fires; "offline" after we've
  // counted MAX_SSE_FAILURES consecutive errors with no successful open
  // in between (the bridge is gone, not just blipping).
  const [connection, setConnection] = useState<LivePillConnection>("reconnecting");
  const [err, setErr] = useState<string>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams?.get("tab");
  const toolFromUrl = searchParams?.get("tool") ?? "";
  const [tab, setTabState] = useState<Tab>(isTab(tabFromUrl) ? tabFromUrl : "all");
  const setTab = (next: Tab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "all") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };
  const clearToolFilter = () => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("tool");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };
  const [, setTick] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  // Pause/resume — events that arrive while paused are buffered so the
  // user doesn't lose context while inspecting a row. Counter drives the
  // resume button label so the user knows what's accumulating.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const pendingBufRef = useRef<ActivityEvent[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  // Seed with recent history on mount, then open the live stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/activity?last=100"));
        if (res.ok) {
          const data = (await res.json()) as { events?: ActivityEvent[] };
          if (!cancelled) {
            // Bridge returns oldest-first; dashboard renders newest-first.
            const hist = (data.events ?? []).map(withAt).reverse();
            setEvents(hist.slice(0, MAX_EVENTS));
          }
        }
      } catch {
        // history fetch failed — live stream still opens below
      }
      if (!cancelled) setSeeded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Browser EventSource auto-retries forever on error. We give up on
    // showing "reconnecting" and downgrade to "offline" after this many
    // consecutive errors without a successful open in between.
    const MAX_SSE_FAILURES = 5;
    let consecutiveErrors = 0;
    const es = new EventSource(apiPath("/api/bridge/stream"));
    esRef.current = es;
    es.onopen = () => {
      consecutiveErrors = 0;
      setConnection("live");
      setErr(undefined);
    };
    es.onerror = () => {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_SSE_FAILURES) {
        setConnection("offline");
      } else {
        setConnection("reconnecting");
      }
      if (!isDemoMode()) setErr("Disconnected — reconnecting…");
    };
    es.onmessage = (msg) => {
      try {
        const entry = withAt(JSON.parse(msg.data) as ActivityEvent);
        if (pausedRef.current) {
          pendingBufRef.current = [entry, ...pendingBufRef.current].slice(0, MAX_EVENTS);
          setPendingCount(pendingBufRef.current.length);
          return;
        }
        setEvents((prev) => {
          // Dedup by (id, kind) so the first live event doesn't duplicate
          // the most recent history row.
          if (
            entry.id !== undefined &&
            prev.some((p) => p.id === entry.id && p.kind === entry.kind)
          ) {
            return prev;
          }
          return [entry, ...prev].slice(0, MAX_EVENTS);
        });
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, []);

  // tick for relative timestamps
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    let out = events;
    if (tab === "tools") {
      out = out.filter((e) => e.kind === "tool");
    } else if (tab === "recipe_start") {
      out = out.filter(
        (e) => RECIPE_START_EVENTS.has(e.kind ?? "") || RECIPE_START_EVENTS.has(e.event ?? ""),
      );
    } else if (tab === "recipe_end") {
      out = out.filter(
        (e) => RECIPE_END_EVENTS.has(e.kind ?? "") || RECIPE_END_EVENTS.has(e.event ?? ""),
      );
    } else {
      out = out.filter(
        (e) => !(e.kind === "lifecycle" && ACTIVITY_NOISE_EVENTS.has(e.event ?? "")),
      );
    }
    if (toolFromUrl) {
      out = out.filter((e) => e.tool === toolFromUrl);
    }
    return out;
  }, [events, tab, toolFromUrl]);

  const stats = useMemo(() => {
    let tools = 0;
    let errors = 0;
    let approvals = 0;
    const toolCounts: Record<string, number> = {};
    for (const e of events) {
      if (e.kind === "tool") {
        tools++;
        if (e.status === "error") errors++;
        if (e.tool) toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
      } else if (e.kind === "lifecycle" && e.event === "approval_decision") {
        approvals++;
      }
    }
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value }));
    return { tools, errors, approvals, topTools };
  }, [events]);

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 className="editorial-h1" style={{ margin: 0 }}>
              Activity — <span className="accent">every tool, every event, in real time.</span>
            </h1>
            <HintCard.Toggle id="activity" />
          </div>
          {events.length > 0 && (
            <div className="editorial-sub">
              {events.length} events · last 24h · {stats.errors} errored
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              if (paused) {
                // Flush buffered events into the visible list, dedup'd.
                const buf = pendingBufRef.current;
                pendingBufRef.current = [];
                setPendingCount(0);
                setEvents((prev) => {
                  const seen = new Set(
                    prev
                      .filter((p) => p.id !== undefined)
                      .map((p) => `${p.id}|${p.kind ?? ""}`),
                  );
                  const fresh = buf.filter(
                    (e) => e.id === undefined || !seen.has(`${e.id}|${e.kind ?? ""}`),
                  );
                  return [...fresh, ...prev].slice(0, MAX_EVENTS);
                });
                setPaused(false);
              } else {
                setPaused(true);
              }
            }}
            aria-pressed={paused}
            title={paused ? "Resume live updates" : "Pause live updates"}
          >
            {paused ? `Resume${pendingCount > 0 ? ` (${pendingCount})` : ""}` : "Pause"}
          </button>
          <LivePill connection={connection} />
        </div>
      </div>

      <HintCard id="activity" />

      {toolFromUrl && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "var(--s-2) var(--s-3)",
            marginBottom: "var(--s-3)",
            background: "var(--bg-2)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2)",
            fontSize: "var(--fs-s)",
          }}
        >
          <span style={{ color: "var(--ink-2)" }}>Filtering by tool:</span>
          <code>{toolFromUrl}</code>
          <button type="button" className="btn sm ghost" onClick={clearToolFilter}>
            Clear
          </button>
        </div>
      )}

      {/*
        Sidebar's Activity nav has a halt-count badge that polls
        /runs/halt-summary. Clicking the badge used to land here on a
        page that never mentioned halts. RecentHaltsPanel surfaces the
        same summary inline so the badge promise is delivered, then
        collapses to nothing when there are zero halts.
      */}
      <RecentHaltsPanel />

      {/* Charts row: histogram + top tools */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr minmax(0, 340px)",
          gap: "var(--s-4)",
          marginBottom: "var(--s-4)",
        }}
      >
        <div className="card" style={{ padding: "14px 18px 10px" }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-2xs)",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 10,
            }}
          >
            Events / minute (last 24h)
          </div>
          <EventsHistogram events={events} hours={24} height={52} granularity="minute" />
        </div>
        {(
          <div className="card" style={{ padding: "14px 18px" }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-2xs)",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: 10,
              }}
            >
              Top tools
            </div>
            <HBarList items={stats.topTools} height={5} />
          </div>
        )}
      </div>

      {/* Tabs (toggle-button group, not ARIA tabs — there's no associated tabpanel
          since the table below is shared and just filters). */}
      <div
        role="group"
        aria-label="Filter events by type"
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border-subtle)",
          marginBottom: 12,
        }}
      >
        {(["all", "tools", "recipe_start", "recipe_end"] as Tab[]).map((t) => {
          const labels: Record<Tab, string> = {
            all: "All",
            tools: "Tool calls",
            recipe_start: "Recipe starts",
            recipe_end: "Recipe ends",
          };
          const count =
            t === "tools"
              ? stats.tools
              : t === "recipe_start"
                ? events.filter(
                    (e) => RECIPE_START_EVENTS.has(e.kind ?? "") || RECIPE_START_EVENTS.has(e.event ?? ""),
                  ).length
                : t === "recipe_end"
                  ? events.filter(
                      (e) => RECIPE_END_EVENTS.has(e.kind ?? "") || RECIPE_END_EVENTS.has(e.event ?? ""),
                    ).length
                  : events.length;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              style={{
                padding: "6px 16px",
                fontSize: "var(--fs-s)",
                fontWeight: 500,
                cursor: "pointer",
                color: tab === t ? "var(--fg-0)" : "var(--fg-2)",
                background: "none",
                border: "none",
                borderBottom:
                  tab === t
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
              }}
            >
              {labels[t]}{" "}
              <span
                style={{
                  fontSize: "var(--fs-xs)",
                  color: tab === t ? "var(--accent)" : "var(--fg-3)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {err && connection !== "live" && <div className="alert-err">{err}</div>}

      {events.length === 0 ? (
        seeded ? (
          <EmptyState
            title="No activity yet"
            description={
              <>
                Tool calls and bridge events will appear here — most recent first.
                <span
                  style={{
                    display: "block",
                    color: "var(--ink-3)",
                    fontSize: "var(--fs-s)",
                    marginTop: "var(--s-3)",
                  }}
                >
                  Connect a Claude Code session to the bridge and call any MCP tool to see your first event.
                </span>
              </>
            }
          />
        ) : (
          <SkeletonList rows={5} columns={4} />
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No events in this view"
          description="Try a different tab."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Time</th>
                <th style={{ width: 110 }}>Kind</th>
                <th style={{ width: 160 }}>Recipe</th>
                <th>Tool / Event</th>
                <th style={{ width: 110 }}>Duration</th>
                <th style={{ width: 130 }}>Status / Decision</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const isTool = e.kind === "tool";
                const isLifecycle = e.kind === "lifecycle";
                const meta = getLifecycleMeta(e);
                const isApproval =
                  isLifecycle && e.event === "approval_decision";

                // Kind badge: specific event name (e.g. tool_call, recipe_step_start, recipe_step_done)
                const kindLabel = isTool ? "tool_call" : (e.event ?? e.kind);
                const kindClass = isApproval
                  ? meta.decision === "allow"
                    ? "ok"
                    : "err"
                  : isTool
                    ? e.status === "error"
                      ? "err"
                      : "ok"
                    : "muted";

                // Tool / Event cell — for lifecycle rows with just a
                // session id, show the session id alone instead of "— (…)".
                const mainLabel = isTool
                  ? (e.tool ?? "—")
                  : isApproval
                    ? (meta.toolName ?? "—")
                    : isLifecycle && meta.sessionId
                      ? `session ${meta.sessionId}`
                      : "—";
                const subLabel =
                  isApproval && meta.specifier ? ` (${meta.specifier})` : "";

                // Duration / reason cell
                const durationCell =
                  typeof e.durationMs === "number"
                    ? `${e.durationMs}ms`
                    : isApproval && meta.reason
                      ? meta.reason
                      : meta.summary
                        ? meta.summary
                        : "—";

                return (
                  <tr key={`${e.kind}-${e.id ?? i}-${i}`} style={{ cursor: "pointer" }}>
                    <td
                      className="muted"
                      title={e.at ? new Date(e.at).toISOString() : ""}
                    >
                      {e.at ? relTime(e.at) : "—"}
                    </td>
                    <td>
                      <span className={`pill ${kindClass}`}>{kindLabel}</span>
                    </td>
                    <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
                      {meta.recipeName ? (
                        <Link
                          href={`/recipes/${encodeURIComponent(meta.recipeName)}/edit`}
                          onClick={(ev) => ev.stopPropagation()}
                          style={{ color: "var(--accent)", textDecoration: "none" }}
                          title={`Recipe ${meta.recipeName}`}
                        >
                          {meta.recipeName}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>
                      {mainLabel}
                      {subLabel && <span className="muted">{subLabel}</span>}
                    </td>
                    <td className="mono muted">{durationCell}</td>
                    <td>
                      {isApproval ? (
                        <span
                          className={`status-cell ${meta.decision === "allow" ? "ok" : "err"}`}
                        >
                          <span className="pill-dot" />
                          {meta.decision ?? "—"}
                        </span>
                      ) : e.status ? (
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
