"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Small card showing the bridge config file path with a copy button.
 * Extracted from settings/page.tsx. Owns only its own copy-feedback
 * state — no settings coupling.
 */
export function ConfigFileCard({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setState("copied");
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setState("idle"), 1500);
    } catch {
      // Clipboard API blocked (insecure context, headless, permission denied).
      // Tell the user instead of silently no-op'ing.
      setState("blocked");
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setState("idle"), 2400);
    }
  }

  const copied = state === "copied";
  const blocked = state === "blocked";

  return (
    <div
      style={{
        marginTop: 16,
        background: "var(--bg-2)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-2)",
        padding: 10,
      }}
    >
      <div
        style={{
          fontSize: "var(--fs-2xs)",
          fontWeight: 600,
          letterSpacing: "0.05em",
          color: "var(--fg-3)",
          textTransform: "uppercase",
        }}
      >
        Config file
      </div>
      <div
        className="mono"
        title={path}
        style={{
          fontSize: "var(--fs-xs)",
          color: "var(--fg-1)",
          marginTop: 6,
          lineHeight: 1.4,
          // Truncate cleanly with an ellipsis rather than breaking the
          // path mid-word ("config.jso\nn"). Full path stays available
          // via the title tooltip and the Copy button below.
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {path}
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy config path"
        style={{
          marginTop: 8,
          background: "transparent",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-s)",
          color: copied ? "var(--ok)" : blocked ? "var(--err)" : "var(--fg-1)",
          fontSize: "var(--fs-xs)",
          padding: "3px 8px",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span aria-hidden>{copied ? "✓" : blocked ? "⚠" : "⧉"}</span>
        {copied
          ? "Copied"
          : blocked
            ? "Copy blocked — select manually"
            : "Copy path"}
      </button>
    </div>
  );
}
