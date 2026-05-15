"use client";
import { useEffect, useState } from "react";
import { isDemoMode, onDemoModeChange } from "@/lib/demoMode";

const DISMISS_KEY = "patchwork.demoBanner.dismissed";

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

export function DemoBanner() {
  const [demo, setDemo] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDemo(isDemoMode());
    setDismissed(readDismissed());
    return onDemoModeChange(setDemo);
  }, []);

  if (!demo || dismissed) return null;

  return (
    <div role="status" className="demo-banner">
      <span className="demo-banner-dot" aria-hidden="true" />
      <span className="demo-banner-text">
        <strong>Demo</strong>
        showing sample data — run Patchwork OS locally for live approvals, recipes, and activity.
      </span>
      <a
        href="https://patchworkos.com/#install"
        target="_blank"
        rel="noopener noreferrer"
        className="demo-banner-cta"
      >
        Install →
      </a>
      <button
        type="button"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
        aria-label="Dismiss demo banner"
        className="demo-banner-dismiss"
      >
        ×
      </button>
    </div>
  );
}
