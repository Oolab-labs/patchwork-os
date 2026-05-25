"use client";

import { useEffect, useState } from "react";
import type { BridgeStatus } from "@/hooks/useBridgeStatus";
import { Glossary } from "@/components/patchwork";

/**
 * Dismissable banner that surfaces a diagnostic when the bridge is
 * offline. Replaces the previous behaviour, where the sidebar pill
 * simply turned red with no explanation — the strategic-critique
 * agent flagged that as the most common failure mode for new users.
 *
 * Layout: thin amber strip at the top of <main>. Hidden when:
 *   - status.ok is true (bridge healthy)
 *   - status.degraded is true (partial — we still trust the SSE
 *     fallback path, so a screaming red banner would be inaccurate)
 *   - user has dismissed it this session (session-scoped, NOT
 *     localStorage — a new tab should still see the warning)
 *
 * The banner intentionally does NOT auto-close on reconnect; once
 * dismissed, it stays dismissed until the next reload. Re-opening
 * automatically would create distracting flicker during transient
 * SSE reconnects (the strategic critique flagged this risk too).
 */

const DISMISS_KEY = "patchwork.bridgeOfflineBanner.dismissed";

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode */
  }
}

function relSeconds(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function BridgeOfflineBanner({ status }: { status: BridgeStatus }) {
  const [dismissed, setDismissed] = useState(false);
  const [, setTick] = useState(0);

  // Initialize dismissal state on mount (sessionStorage is not safe in SSR)
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  // Refresh the "last attempt N seconds ago" text every 5 s while visible.
  // We don't need millisecond precision; this keeps the banner from
  // looking frozen during a long offline stretch.
  useEffect(() => {
    if (status.ok || status.degraded || dismissed) return;
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [status.ok, status.degraded, dismissed]);

  if (status.ok || status.degraded || dismissed) return null;

  const lastAttempt = status.lastAttemptAt;
  const port = status.patchwork?.port ?? status.port ?? 3101;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "color-mix(in srgb, var(--amber) 14%, var(--surface))",
        borderBottom: "1px solid color-mix(in srgb, var(--amber) 40%, transparent)",
        padding: "10px 20px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        fontSize: "var(--fs-s)",
        color: "var(--ink-1)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--amber)",
          flexShrink: 0,
        }}
      />
      <strong style={{ fontWeight: 600 }}>
        <Glossary term="bridge">Bridge</Glossary> offline.
      </strong>
      <span style={{ color: "var(--ink-2)" }}>
        The dashboard can&apos;t reach the Patchwork{" "}
        <Glossary term="bridge">bridge</Glossary>.
        {lastAttempt && ` Last attempt ${relSeconds(lastAttempt)}.`}
        {status.lastError && ` Reason: ${status.lastError}.`}
      </span>

      <span style={{ flex: 1, minWidth: 12 }} aria-hidden="true" />

      {/*
        Inline CLI command. The user can copy + paste to a terminal —
        no GUI button to start the bridge because that would need
        elevated privileges; the dashboard runs in the browser.
      */}
      <code
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-xs)",
          padding: "3px 8px",
          background: "var(--recess)",
          borderRadius: "var(--r-2)",
          color: "var(--ink-1)",
          whiteSpace: "nowrap",
        }}
      >
        patchwork start --port {port}
      </code>

      <button
        type="button"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
        aria-label="Dismiss bridge-offline banner"
        className="bridge-offline-dismiss"
        style={{
          background: "transparent",
          border: "1px solid color-mix(in srgb, var(--amber) 35%, transparent)",
          color: "var(--ink-2)",
          padding: "4px 10px",
          borderRadius: "var(--r-2)",
          fontSize: "var(--fs-xs)",
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
