"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBridgeStream } from "@/hooks/useBridgeStream";

/**
 * Compact live-event ticker for the topbar.
 *
 * Surfaces the three most-recent events the bridge has emitted, so the
 * dashboard feels alive on every page (not just /activity). Reuses the
 * existing useBridgeStream hook so we share one SSE connection with the
 * /activity page rather than opening a second EventSource per tab.
 *
 * Hidden when:
 *   - mobile breakpoint (CSS handles this — the topbar already collapses)
 *   - bridge is unreachable (no events to show; degrades to nothing)
 *   - user dismissed the ticker (localStorage, since this is a topbar
 *     element the user has to look at every page; respect that choice)
 *
 * Each event is clickable → /activity?focus=<id> so the user can pivot
 * from a glimpse on any page to the full thread.
 */

const STORAGE_KEY = "patchwork.activityTicker.dismissed";
const MAX_VISIBLE = 3;
const MAX_KEPT = 20;

interface TickerEvent {
  id?: number;
  kind: string;
  tool?: string;
  event?: string;
  status?: "success" | "error";
  durationMs?: number;
  timestamp?: string;
  at?: number;
  metadata?: Record<string, unknown>;
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}

/**
 * Pull a 1-line human label out of the event. Tools render their name +
 * outcome; lifecycle events render the event name + the most-meaningful
 * piece of metadata (tool name for approvals, summary for recipe ends).
 */
function describe(e: TickerEvent): string {
  if (e.kind === "tool" && typeof e.tool === "string") {
    const status = e.status === "error" ? " · error" : "";
    const dur =
      typeof e.durationMs === "number" && e.durationMs > 0
        ? ` (${e.durationMs}ms)`
        : "";
    return `${e.tool}${status}${dur}`;
  }
  if (typeof e.event === "string") {
    const meta = e.metadata ?? {};
    const toolName = typeof meta.toolName === "string" ? meta.toolName : "";
    const decision = typeof meta.decision === "string" ? meta.decision : "";
    if (e.event === "approval_decision" && toolName)
      return `${decision || "decided"} · ${toolName}`;
    if (e.event === "approval_request" && toolName) return `approval · ${toolName}`;
    return e.event;
  }
  return e.kind;
}

function tone(e: TickerEvent): "ok" | "err" | "muted" {
  if (e.kind === "tool" && e.status === "error") return "err";
  if (e.kind === "tool") return "ok";
  if (e.event === "approval_request") return "muted";
  return "muted";
}

const TONE_COLORS: Record<"ok" | "err" | "muted", string> = {
  ok: "var(--green)",
  err: "var(--red)",
  muted: "var(--ink-3)",
};

export function ActivityTicker() {
  const [events, setEvents] = useState<TickerEvent[]>([]);
  const [dismissed, setDismissed] = useState(false);
  // LOW #44: replace lastIdRef (single value) with a bounded Set so
  // non-adjacent duplicates (id:5, id:6, id:5) are also deduplicated.
  // Oldest ID is evicted once the set exceeds MAX_DEDUP_IDS entries.
  const MAX_DEDUP_IDS = 50;
  const seenIdsRef = useRef<Set<number>>(new Set());
  const seenIdsOrderRef = useRef<number[]>([]);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const onEvent = useCallback((_type: string, data: unknown) => {
    if (!data || typeof data !== "object") return;
    const e = data as TickerEvent;
    // Dedup by id using a bounded Set — catches both adjacent and non-adjacent
    // duplicates (e.g. SSE replay of an ID we already showed).
    if (e.id !== undefined) {
      if (seenIdsRef.current.has(e.id)) return;
      seenIdsRef.current.add(e.id);
      seenIdsOrderRef.current.push(e.id);
      // Evict oldest when window exceeds cap.
      if (seenIdsOrderRef.current.length > MAX_DEDUP_IDS) {
        const evicted = seenIdsOrderRef.current.shift();
        if (evicted !== undefined) seenIdsRef.current.delete(evicted);
      }
    }
    setEvents((prev) => {
      const next: TickerEvent[] = [e, ...prev];
      // Keep a small window — older events leave the ticker quickly.
      return next.slice(0, MAX_KEPT);
    });
  }, []);

  const { connected } = useBridgeStream("/api/bridge/stream", onEvent, {
    enabled: !dismissed,
  });

  if (dismissed) return null;

  const visible = events.slice(0, MAX_VISIBLE);

  return (
    <div
      className="activity-ticker"
      // Decorative "feels alive" ticker — its three rows churn every few
      // seconds. `aria-live="polite"` here produced continuous
      // screen-reader chatter for no actionable benefit (the same events
      // are reachable via the /activity page). Mark it `aria-live="off"`
      // and drop `role="status"` so assistive tech ignores the churn;
      // the rows stay individually focusable links for anyone who wants
      // to explore them.
      aria-label="Live activity ticker"
      aria-live="off"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 24,
        padding: "0 10px",
        fontSize: "var(--fs-xs)",
        color: "var(--ink-2)",
        overflow: "hidden",
        maxWidth: 520,
        flex: "0 1 520px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: connected ? "var(--green)" : "var(--dot-muted)",
          flexShrink: 0,
          boxShadow: connected
            ? "0 0 6px color-mix(in srgb, var(--green) 60%, transparent)"
            : "none",
        }}
      />
      {visible.length === 0 ? (
        <span style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}>
          {/*
            This indicator reflects the LIVE EVENT STREAM (SSE), which is
            a distinct system from the bridge process itself. The bridge
            can be reachable (header pill green, /status 200) while the
            event stream is unavailable — e.g. the bridge's SSE
            subscriber cap is saturated. Label it "Live stream" rather
            than "Bridge" so the two indicators can never appear to
            contradict each other.
          */}
          {connected ? "Listening for events…" : "Live stream offline"}
        </span>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            gap: 8,
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {visible.map((e, i) => {
            const label = describe(e);
            const t = tone(e);
            const href = `/activity${e.id !== undefined ? `?focus=${e.id}` : ""}`;
            return (
              <li
                key={`${e.id ?? "x"}-${i}`}
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: i === 0 ? "1 1 auto" : "0 1 auto",
                  maxWidth: i === 0 ? 260 : 140,
                }}
              >
                <Link
                  href={href}
                  title={label}
                  style={{
                    color: TONE_COLORS[t],
                    textDecoration: "none",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className="activity-ticker-close"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
        aria-label="Hide activity ticker"
        title="Hide ticker"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--ink-3)",
          padding: "0 4px",
          cursor: "pointer",
          fontSize: "var(--fs-xs)",
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
