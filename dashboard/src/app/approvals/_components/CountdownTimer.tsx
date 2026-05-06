"use client";
import { useEffect, useState } from "react";

export function CountdownTimer({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Date.now()),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (remaining === 0) {
    return (
      <span
        className="countdown urgent"
        style={{ color: "var(--err)", fontWeight: 600 }}
        title="Expired"
      >
        Expired
      </span>
    );
  }

  const totalSecs = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  // Two-tier urgency: amber 30-60s (warning), red+pulsing <30s (critical).
  const critical = remaining < 30_000;
  const warning = !critical && remaining < 60_000;
  const label =
    mins > 0
      ? `${mins}m ${secs}s remaining`
      : `${secs}s remaining`;

  return (
    <span
      className={`countdown${critical ? " urgent" : warning ? " warn" : ""}`}
      style={
        critical
          ? {
              color: "var(--err)",
              fontWeight: 600,
              animation: "pulse-dot 0.8s ease-in-out infinite",
            }
          : warning
            ? { color: "var(--warn)", fontWeight: 600 }
            : undefined
      }
      title={`Expires at ${new Date(expiresAt).toLocaleTimeString()}`}
    >
      {label}
    </span>
  );
}
