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

export function useBridgeStatus(): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>({ ok: false });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/status"));
        if (!res.ok) throw new Error(`status ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json") && !ct.includes("text/plain")) throw new Error("bad content-type");
        const data = (await res.json()) as Partial<BridgeStatus>;
        if (alive) setStatus({ ok: true, ...data });
      } catch {
        try {
          const res = await fetch(apiPath("/api/bridge/approvals"));
          const ct = res.headers.get("content-type") ?? "";
          if (alive) setStatus({ ok: res.ok && ct.includes("application/json") });
        } catch {
          if (alive) setStatus({ ok: false });
        }
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return status;
}
