"use client";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { subscribeStreamLiveness } from "@/lib/streamLiveness";

export interface BridgeStatus {
  ok: boolean;
  /** /status failed but a fallback endpoint responded — bridge is reachable but reporting degraded. */
  degraded?: boolean;
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
      try {
        const res = await fetch(apiPath("/api/bridge/status"));
        if (!res.ok) throw new Error(`status ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json") && !ct.includes("text/plain"))
          throw new Error("bad content-type");
        const data = (await res.json()) as Partial<BridgeStatus>;
        if (alive) setStatus({ ok: true, ...data });
        succeeded = true;
      } catch {
        // /status failed. Probe /approvals as a heartbeat — if it responds we
        // know the dashboard API is reachable, but the bridge itself is not
        // reporting healthy. Surface that as `degraded`, NOT `ok`, so banners
        // and gating logic can distinguish "fully up" from "partially up".
        try {
          const res = await fetch(apiPath("/api/bridge/approvals"));
          const ct = res.headers.get("content-type") ?? "";
          const reachable = res.ok && ct.includes("application/json");
          if (alive) setStatus({ ok: false, degraded: reachable });
        } catch {
          if (alive) setStatus({ ok: false, degraded: false });
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
  return status;
}
