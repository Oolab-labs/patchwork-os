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
    <div role="status" className="demo-banner" style={{ position: "sticky", top: 0 }}>
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
    </div>
  );
}
