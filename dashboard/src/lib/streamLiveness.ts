"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

/**
 * Singleton SSE liveness watcher.
 *
 * The dashboard polls `/api/bridge/status` every 5 s and
 * `/api/bridge/approvals` every 5 s from multiple consumers (header
 * approval-count badge, home page metrics, settings page). It also
 * holds a live SSE connection (`/api/bridge/stream`) for approval
 * decision events. While the SSE is healthy and pushing heartbeats,
 * the polls are redundant traffic — on a phone over cellular this
 * adds up to ~720 needless requests/hour.
 *
 * This module opens ONE shared EventSource (per browser tab) and
 * exposes a tiny pub-sub: poll consumers subscribe with
 * `subscribeStreamLiveness` and slow their cadence when `isLive`
 * goes true. When SSE drops, consumers accelerate back to 5 s
 * polling automatically.
 *
 * The stream is opened lazily on first subscription and closed when
 * the last subscriber unsubscribes (typical on full-page nav).
 */

const listeners = new Set<(live: boolean) => void>();
const messageListeners = new Set<(type: string, data: unknown) => void>();
let es: EventSource | null = null;
let isLive = false;
let lastHeartbeatAt = 0;

/** SSE is "live" if connected AND we've seen activity in the last 90 s. */
const HEARTBEAT_TIMEOUT_MS = 90_000;

function notify() {
  for (const l of listeners) l(isLive);
}

function setLive(next: boolean) {
  if (next === isLive) return;
  isLive = next;
  notify();
}

function ensureStream() {
  if (es) return;
  if (typeof window === "undefined") return;

  try {
    es = new EventSource(apiPath("/api/bridge/stream"));
  } catch {
    return;
  }

  es.onopen = () => {
    lastHeartbeatAt = Date.now();
    setLive(true);
  };

  es.onmessage = (msg) => {
    lastHeartbeatAt = Date.now();
    if (!isLive) setLive(true);
    if (messageListeners.size === 0) return;
    // Parse + dispatch to message subscribers. Wrapped in try so a
    // malformed payload doesn't break the heartbeat path above.
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      return;
    }
    const obj = parsed as { kind?: string; type?: string } | null;
    const type =
      (obj && typeof obj === "object" && (obj.kind ?? obj.type)) || "message";
    for (const cb of messageListeners) {
      try {
        cb(type, parsed);
      } catch {
        // isolate one bad subscriber from the rest
      }
    }
  };

  es.onerror = () => {
    setLive(false);
    // EventSource auto-reconnects; we'll re-fire onopen if it
    // succeeds. No manual cleanup here — keep the reference so
    // subsequent ensureStream() calls don't open a second one.
  };
}

function teardownStream() {
  if (!es) return;
  es.close();
  es = null;
  lastHeartbeatAt = 0;
  // Route through setLive so getStreamLiveness() (and any future
  // listener) sees a consistent value — a bare `isLive = false`
  // bypassed notify() and left non-React readers stale.
  setLive(false);
}

function streamHasSubscribers(): boolean {
  return listeners.size > 0 || messageListeners.size > 0;
}

/**
 * Subscribe to parsed SSE messages from the shared stream. Returns
 * unsubscribe. The callback receives `(type, data)` where `type` is
 * pulled from `data.kind` (preferred) or `data.type`, falling back
 * to `"message"`. Malformed JSON payloads are dropped silently.
 *
 * Consumers that previously opened their own EventSource on
 * `/api/bridge/stream` should subscribe here instead — same stream,
 * one socket per tab.
 */
export function subscribeStreamMessage(
  cb: (type: string, data: unknown) => void,
): () => void {
  messageListeners.add(cb);
  ensureStream();
  return () => {
    messageListeners.delete(cb);
    if (!streamHasSubscribers()) {
      teardownStream();
    }
  };
}

/**
 * Subscribe to SSE liveness changes.
 *
 * The callback is invoked once on subscription with the current
 * value, and again whenever liveness flips. Returns an unsubscribe.
 */
export function subscribeStreamLiveness(
  cb: (live: boolean) => void,
): () => void {
  listeners.add(cb);
  ensureStream();
  cb(isLive);
  // Stale-heartbeat sweep: if we've been "live" but haven't received
  // an event in 90 s, downgrade to not-live so polls resume. Cheap
  // belt-and-suspenders against EventSource's silent disconnects.
  const sweepId = setInterval(() => {
    if (isLive && Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      setLive(false);
    }
  }, 30_000);

  return () => {
    listeners.delete(cb);
    clearInterval(sweepId);
    if (!streamHasSubscribers()) {
      teardownStream();
    }
  };
}

/** React hook wrapping the subscription. Re-renders on liveness change. */
export function useStreamLiveness(): boolean {
  const [live, setLiveState] = useState(false);
  useEffect(() => subscribeStreamLiveness(setLiveState), []);
  return live;
}

/**
 * Synchronous read of current liveness for non-React callers that just
 * need a snapshot at tick time. Stays in sync via the same subscription
 * mechanism — anyone using this should call `subscribeStreamLiveness`
 * elsewhere to keep the stream open.
 */
export function getStreamLiveness(): boolean {
  return isLive;
}
