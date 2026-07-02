"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

/**
 * Page-level "Show details" affordance, shared across the redesigned pages.
 *
 * One boolean — expert mode — persisted in localStorage so the operator's
 * choice sticks across navigations and reloads, and synced across every
 * `useExpertMode()` consumer on the page (many `DetailsFold` regions + one
 * `ExpertToggle`) via a custom same-tab event plus the native cross-tab
 * `storage` event. Replaces the workers page's local `expert` useState.
 *
 * Expert content is never deleted — `DetailsFold` folds it away and marks
 * the region `data-details` so the Playwright "glance test" can assert the
 * default view is jargon-free while allowing raw terms inside the fold.
 */

const STORAGE_KEY = "pw:expert";
const SYNC_EVENT = "pw:expert-change";

function readStored(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ExpertMode {
  expert: boolean;
  setExpert: (v: boolean) => void;
  toggle: () => void;
}

export function useExpertMode(): ExpertMode {
  // SSR-safe: start false (server + first client render agree), hydrate from
  // storage in an effect to avoid a hydration mismatch.
  const [expert, setExpertState] = useState(false);

  useEffect(() => {
    const sync = () => setExpertState(readStored());
    sync();
    window.addEventListener(SYNC_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SYNC_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setExpert = useCallback((v: boolean) => {
    setExpertState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // Private mode / storage disabled — state still works in-memory for
      // this session; just not persisted.
    }
    // Notify sibling consumers in THIS tab (storage event only fires in others).
    window.dispatchEvent(new Event(SYNC_EVENT));
  }, []);

  const toggle = useCallback(() => setExpert(!readStored()), [setExpert]);

  return { expert, setExpert, toggle };
}

/**
 * The page-level toggle button. Renders "Show details ▸" / "Hide details ▾".
 * Any number can be on a page; they all reflect and drive the same state.
 */
export function ExpertToggle({ style, className }: { style?: React.CSSProperties; className?: string }) {
  const { expert, toggle } = useExpertMode();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={expert}
      className={className}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        fontSize: "var(--fs-s)",
        fontWeight: 500,
        color: "var(--ink-2)",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        ...style,
      }}
    >
      {expert ? "Hide details" : "Show details"}
      <span aria-hidden="true">{expert ? "▾" : "▸"}</span>
    </button>
  );
}

/**
 * A region that only renders (and is only in the DOM) when expert mode is on.
 * Marked `data-details` so the glance test can scope banned-jargon checks.
 */
export function DetailsFold({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  const { expert } = useExpertMode();
  if (!expert) return null;
  return (
    <div data-details="" className={className} style={style}>
      {children}
    </div>
  );
}
