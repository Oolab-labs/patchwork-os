"use client";
import { useEffect, useState } from "react";
import { useBridgeStatus } from "@/hooks/useBridgeStatus";
import { apiPath } from "@/lib/api";

/**
 * Sticky global banner that surfaces bridge-offline state on every page.
 * Renders nothing while the bridge is reachable.
 */
export function BridgeBanner() {
  const status = useBridgeStatus();
  const [dismissed, setDismissed] = useState(false);
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);

  // Track the last time we saw the bridge online.
  useEffect(() => {
    if (status.ok) {
      setLastSeen(Date.now());
      setDismissed(false);
    }
  }, [status.ok]);

  // Tick once a second so the "last seen Xs ago" copy stays fresh.
  useEffect(() => {
    if (status.ok || dismissed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status.ok, dismissed]);

  if (status.ok || dismissed) return null;

  const ageSec = lastSeen ? Math.max(0, Math.round((now - lastSeen) / 1000)) : null;
  const ageText = ageSec === null
    ? "never connected"
    : ageSec < 60
      ? `last seen ${ageSec}s ago`
      : ageSec < 3600
        ? `last seen ${Math.round(ageSec / 60)}m ago`
        : `last seen ${Math.round(ageSec / 3600)}h ago`;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      // Best-effort poke — useBridgeStatus is on its own backoff loop and will
      // pick up the new state on its next tick regardless.
      await fetch(apiPath("/api/bridge/status"), { cache: "no-store" });
    } catch {
      /* ignore — banner stays */
    } finally {
      setTimeout(() => setRetrying(false), 600);
    }
  };

  return (
    <div className="bridge-banner" role="status" aria-live="polite">
      <span className="bridge-banner-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
      <span className="bridge-banner-message">
        {status.degraded
          ? `Bridge degraded — /status not responding, ${ageText}`
          : `Bridge offline — ${ageText}`}
      </span>
      <button
        type="button"
        className="bridge-banner-retry"
        onClick={handleRetry}
        disabled={retrying}
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
      <button
        type="button"
        className="bridge-banner-dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
