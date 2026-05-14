"use client";

import { useCallback, useEffect, useState } from "react";
import { findHint } from "@/lib/hints";

/**
 * Dismissable "what's this?" card surfaced once per page on first visit.
 *
 * Behaviour:
 *   - Renders the `Hint` with the given `id` (from src/lib/hints.ts).
 *   - Hidden when the user has dismissed it (localStorage, persistent).
 *   - A small `?` button next to the page H1 re-opens a hint that's
 *     been dismissed — that's the discoverability hook so first-time
 *     dismissal doesn't lose the explanation forever.
 *
 * Renders TWO pieces:
 *   1) `<HintCard id="…" />` — the dismissable card (place under the page H1)
 *   2) `<HintCard.Toggle id="…" />` — the `?` icon button (place in the
 *      page header, near the title or actions row).
 *
 * Toggle and card communicate via the shared localStorage key. Multiple
 * mounts of the same id are safe — they share state through `storage`
 * events plus a window-level CustomEvent for same-document updates.
 */

const STORAGE_PREFIX = "patchwork.hint.";
const STORAGE_SUFFIX = ".dismissed";

function storageKey(id: string) {
  return `${STORAGE_PREFIX}${id}${STORAGE_SUFFIX}`;
}

const EVENT_NAME = "patchwork-hint-toggle";

function readDismissed(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(id: string, dismissed: boolean) {
  try {
    if (dismissed) window.localStorage.setItem(storageKey(id), "1");
    else window.localStorage.removeItem(storageKey(id));
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, { detail: { id, dismissed } }),
    );
  } catch {
    /* private mode */
  }
}

function useDismissed(id: string): [boolean, (next: boolean) => void] {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(readDismissed(id));
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(id)) setDismissed(e.newValue === "1");
    };
    const onCustom = (e: Event) => {
      const ce = e as CustomEvent<{ id: string; dismissed: boolean }>;
      if (ce.detail?.id === id) setDismissed(ce.detail.dismissed);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT_NAME, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT_NAME, onCustom);
    };
  }, [id]);
  const set = useCallback(
    (next: boolean) => {
      setDismissed(next);
      writeDismissed(id, next);
    },
    [id],
  );
  return [dismissed, set];
}

interface HintCardComponent {
  (props: { id: string }): JSX.Element | null;
  Toggle: (props: { id: string; ariaLabel?: string }) => JSX.Element | null;
}

const HintCardImpl = ({ id }: { id: string }) => {
  const hint = findHint(id);
  const [dismissed, setDismissed] = useDismissed(id);
  if (!hint || dismissed) return null;
  return (
    <aside
      role="note"
      aria-labelledby={`hint-${id}-title`}
      style={{
        marginTop: 12,
        marginBottom: 12,
        padding: "12px 16px",
        background: "color-mix(in srgb, var(--accent) 6%, var(--surface))",
        border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
        borderRadius: "var(--r-3)",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "start",
        gap: 12,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "color-mix(in srgb, var(--accent) 18%, transparent)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--fs-xs)",
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ✦
      </span>
      <div style={{ minWidth: 0 }}>
        <strong
          id={`hint-${id}-title`}
          style={{
            display: "block",
            fontSize: "var(--fs-s)",
            color: "var(--ink-1)",
            marginBottom: 2,
          }}
        >
          {hint.title}
        </strong>
        <div style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)", lineHeight: 1.45 }}>
          {hint.body}
        </div>
        {hint.tip && (
          <div
            style={{
              fontSize: "var(--fs-xs)",
              color: "var(--ink-3)",
              marginTop: 6,
            }}
          >
            {hint.tip}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss this hint"
        style={{
          background: "transparent",
          border: "none",
          padding: "2px 6px",
          color: "var(--ink-3)",
          cursor: "pointer",
          fontSize: "var(--fs-s)",
          alignSelf: "start",
        }}
      >
        ✕
      </button>
    </aside>
  );
};

const HintCardToggle = ({
  id,
  ariaLabel,
}: {
  id: string;
  ariaLabel?: string;
}) => {
  const hint = findHint(id);
  const [dismissed, setDismissed] = useDismissed(id);
  if (!hint) return null;
  // Only show the toggle when the card is currently hidden; if the
  // card is visible, the toggle would be redundant with the X button.
  if (!dismissed) return null;
  return (
    <button
      type="button"
      onClick={() => setDismissed(false)}
      aria-label={ariaLabel ?? `Show hint: ${hint.title}`}
      title={`Show hint: ${hint.title}`}
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: "1px solid var(--line-2)",
        background: "transparent",
        color: "var(--ink-3)",
        cursor: "pointer",
        fontSize: "var(--fs-xs)",
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      ?
    </button>
  );
};

export const HintCard = HintCardImpl as HintCardComponent;
HintCard.Toggle = HintCardToggle;
