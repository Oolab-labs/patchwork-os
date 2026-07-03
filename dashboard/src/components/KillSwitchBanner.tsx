"use client";

import { useState } from "react";
import { apiPath } from "@/lib/api";
import { KillSwitchConfirmDialog } from "@/components/KillSwitchConfirmDialog";

interface KillSwitchBannerProps {
  engaged: boolean;
  locked: boolean;
}

/**
 * Displays a prominent warning banner when the write kill-switch is engaged.
 * Renders nothing when engaged=false.
 */
export function KillSwitchBanner({ engaged, locked }: KillSwitchBannerProps) {
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!engaged) return null;

  const doRelease = async () => {
    if (releasing || locked) return;
    setReleasing(true);
    setReleaseError(null);
    try {
      const res = await fetch(apiPath("/api/bridge/kill-switch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engage: false }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          lockedReason?: string;
        };
        setReleaseError(
          body.lockedReason ?? body.error ?? `Request failed (${res.status})`,
        );
      }
    } catch {
      setReleaseError("Network error — bridge may be offline.");
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        padding: "10px 16px",
        background: "var(--err-soft)",
        borderLeft: "4px solid var(--err)",
        borderRadius: "var(--r-s)",
        marginBottom: "var(--s-4)",
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: "var(--fs-s)",
          color: "var(--ink-0)",
          fontWeight: 500,
        }}
      >
        ⚠ Write kill-switch is ENGAGED — all recipe writes are blocked.
      </span>

      {releaseError && (
        <span
          style={{
            fontSize: "var(--fs-xs, var(--fs-s))",
            color: "var(--err)",
            flexBasis: "100%",
          }}
        >
          {releaseError}
        </span>
      )}

      <button
        type="button"
        className="btn"
        disabled={locked || releasing}
        onClick={() => setConfirmOpen(true)}
        title={locked ? "(env-locked) Cannot release — set by environment variable at startup." : undefined}
        style={{ fontSize: "var(--fs-s)", whiteSpace: "nowrap" }}
      >
        {releasing ? "Releasing…" : "Release"}
        {locked && (
          <span
            style={{
              marginLeft: 6,
              fontSize: "var(--fs-xs, var(--fs-s))",
              opacity: 0.7,
            }}
          >
            (env-locked)
          </span>
        )}
      </button>

      <KillSwitchConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doRelease}
        direction="release"
      />
    </div>
  );
}
