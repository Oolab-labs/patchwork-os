"use client";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { subscribeStreamLiveness } from "@/lib/streamLiveness";

export interface BridgeStatus {
  ok: boolean;
  /** /status failed but a fallback endpoint responded — bridge is reachable but reporting degraded. */
  degraded?: boolean;
  /**
   * Timestamp (ms since epoch) of the most-recent poll attempt — set on
   * BOTH success and failure. The offline banner uses this to render
   * "last attempt N s ago" so users can see polling is still happening
   * instead of suspecting the dashboard itself has frozen.
   */
  lastAttemptAt?: number;
  /** Short human-readable failure reason from the most-recent failed poll. */
  lastError?: string;
  port?: number;
  workspace?: string;
  extensionConnected?: boolean;
  slim?: boolean;
  approvalGate?: string;
  uptimeMs?: number;
  activeSessions?: number;
  patchwork?: {
    port?: number;
    workspace?: string;
    approvalGate?: string;
    driver?: string;
    model?: string;
    version?: string;
  };
  killSwitch?: { engaged: boolean; locked: boolean } | null;
}

const BASE_INTERVAL_MS = 5000;
/** Polling cadence while SSE liveness is healthy. Status doesn't drift
 *  fast and SSE pushes meaningful state changes; this becomes a slow
 *  metadata refresh rather than a heartbeat. */
const SSE_LIVE_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

function nextDelay(failures: number): number {
  const exp = Math.min(BASE_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
  return exp * (0.8 + Math.random() * 0.4); // ±20% jitter
}

const KILL_SWITCH_POLL_MS = 10_000;

export function useBridgeStatus(): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>({ ok: false });
  useEffect(() => {
    let alive = true;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let sseLive = false;

    const reschedule = (ms: number) => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (!alive) return;
      timerId = setTimeout(tick, ms);
    };

    const tick = async () => {
      let succeeded = false;
      const attemptedAt = Date.now();
      try {
        const res = await fetch(apiPath("/api/bridge/status"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json") && !ct.includes("text/plain"))
          throw new Error("bad content-type");
        const data = (await res.json()) as Partial<BridgeStatus>;
        if (alive) setStatus({ ok: true, lastAttemptAt: attemptedAt, ...data });
        succeeded = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "unreachable";
        // /status failed. Probe /approvals as a heartbeat — if it responds we
        // know the dashboard API is reachable, but the bridge itself is not
        // reporting healthy. Surface that as `degraded`, NOT `ok`, so banners
        // and gating logic can distinguish "fully up" from "partially up".
        try {
          const res = await fetch(apiPath("/api/bridge/approvals"));
          const ct = res.headers.get("content-type") ?? "";
          const reachable = res.ok && ct.includes("application/json");
          if (alive)
            setStatus({
              ok: false,
              degraded: reachable,
              lastAttemptAt: attemptedAt,
              lastError: reachable ? "bridge reported unhealthy" : message,
            });
        } catch {
          if (alive)
            setStatus({
              ok: false,
              degraded: false,
              lastAttemptAt: attemptedAt,
              lastError: message,
            });
        }
      }

      if (succeeded) failures = 0;
      else failures++;
      // Slow polling when the SSE stream is healthy: the bridge pushes
      // state changes through it, so the every-5-s heartbeat poll is
      // redundant traffic. On cellular this matters.
      const baseInterval = sseLive ? SSE_LIVE_INTERVAL_MS : BASE_INTERVAL_MS;
      reschedule(succeeded ? baseInterval : nextDelay(failures));
    };

    // Subscribe to SSE liveness so we slow polls when the stream is
    // healthy and accelerate them when it drops. The callback fires
    // immediately with the current value on subscribe.
    const unsubLiveness = subscribeStreamLiveness((live) => {
      const wasLive = sseLive;
      sseLive = live;
      // SSE just dropped — don't wait the full 30 s slow interval to
      // re-poll; refresh now so the user sees the bridge going offline
      // promptly.
      if (wasLive && !live) reschedule(0);
    });

    tick();
    return () => {
      alive = false;
      if (timerId !== null) clearTimeout(timerId);
      unsubLiveness();
    };
  }, []);

  // Poll kill-switch state independently — it can change at any time and
  // the status endpoint doesn't include it.
  useEffect(() => {
    let alive = true;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/kill-switch"), {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as {
            engaged: boolean;
            locked: boolean;
          };
          if (alive) {
            setStatus((prev) => ({ ...prev, killSwitch: data }));
          }
          failures = 0;
        } else {
          failures++;
        }
      } catch (e) {
        // AbortError on unmount is expected — don't bump the failure counter.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          failures++;
        }
        // Bridge offline — leave killSwitch as-is
      }
      // #605: exponential backoff on persistent failure. Previously
      // fired every 10s regardless — 360 req/hour per open tab while
      // the bridge is offline. Reuse the same backoff curve as the
      // status poll above.
      if (alive) {
        const delay =
          failures === 0
            ? KILL_SWITCH_POLL_MS
            : Math.min(KILL_SWITCH_POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
        timerId = setTimeout(poll, delay);
      }
    };

    poll();
    return () => {
      alive = false;
      controller.abort();
      if (timerId !== null) clearTimeout(timerId);
    };
  }, []);

  return status;
}
