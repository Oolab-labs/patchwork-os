"use client";
import { useEffect, useState } from "react";
import { isDemoMode, onDemoModeChange } from "@/lib/demoMode";

export function DemoBanner() {
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    setDemo(isDemoMode());
    return onDemoModeChange(setDemo);
  }, []);

  if (!demo) return null;

  return (
    <div
      role="status"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "rgba(216,119,87,0.10)",
        borderBottom: "1px solid rgba(216,119,87,0.25)",
        padding: "7px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        fontSize: 12,
        color: "var(--fg-0)",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--orange)",
          display: "inline-block",
          flexShrink: 0,
          animation: "pulse 2s infinite",
        }}
        aria-hidden="true"
      />
      <span>
        <strong style={{ color: "var(--orange)", fontWeight: 700 }}>Demo mode</strong>
        {" — "}
        showing sample data. Run Patchwork OS locally for live approvals, recipes, and activity.
      </span>
      <a
        href="https://github.com/Oolab-labs/claude-ide-bridge#installation"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: "3px 10px",
          borderRadius: "var(--r-full)",
          background: "var(--accent-soft)",
          color: "var(--accent-strong)",
          border: "1px solid rgba(99,102,241,0.25)",
          textDecoration: "none",
          flexShrink: 0,
        }}
      >
        Install →
      </a>
    </div>
  );
}
