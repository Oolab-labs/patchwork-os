"use client";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

export interface BridgeStatus {
  ok: boolean;
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
  };
}

const BASE_INTERVAL_MS = 5000;
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

    const schedule = (ms: number) => {
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
        try {
          const res = await fetch(apiPath("/api/bridge/approvals"));
          const ct = res.headers.get("content-type") ?? "";
          if (alive)
            setStatus({ ok: res.ok && ct.includes("application/json") });
          if (res.ok) succeeded = true;
        } catch {
          if (alive) setStatus({ ok: false });
        }
      }

      if (succeeded) failures = 0;
      else failures++;
      schedule(succeeded ? BASE_INTERVAL_MS : nextDelay(failures));
    };

    tick();
    return () => {
      alive = false;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, []);
  return status;
}
