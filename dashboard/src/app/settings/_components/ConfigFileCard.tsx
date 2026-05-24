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
    <div className="stg-config-card">
      <div className="stg-config-label">Config file</div>
      <div className="mono stg-config-path" title={path}>
        {path}
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy config path"
        className="stg-config-copy-btn"
        data-state={state}
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
