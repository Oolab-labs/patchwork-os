"use client";

import Link from "next/link";
import {
  type CSSProperties,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { findGlossary } from "@/lib/glossary";

/**
 * Inline hover-defined term. Wraps a domain word in prose with a
 * dotted underline; hover/focus reveals a 1-sentence definition and a
 * "Learn more →" link to the destination page.
 *
 * Example:
 *
 *   "Tool calls your agents want to run that need a human nod
 *    — that's an <Glossary term="approval">approval</Glossary>."
 *
 * Behaviour:
 *   - Hover OR keyboard focus opens the popover (a11y).
 *   - Escape closes it.
 *   - The trigger is `<button>` (no ambiguity for screen readers).
 *   - Mouse leaves close after a small grace period so the user can
 *     move from trigger to popover without flicker.
 *   - Renders as a no-op span if `term` isn't in the glossary
 *     registry — fails open rather than throwing.
 */

const LEAVE_GRACE_MS = 120;

export interface GlossaryProps {
  /** Term identifier (case-insensitive). Must exist in src/lib/glossary.ts. */
  term: string;
  /** The visible text — usually the term itself, possibly cased differently. */
  children: ReactNode;
  /** Optional inline style on the trigger. */
  style?: CSSProperties;
}

export function Glossary({ term, children, style }: GlossaryProps) {
  const entry = findGlossary(term);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fail open: unknown terms render as plain text. Logging a warning
  // would be noisier than helpful — registry typos are caught by
  // grep / search; this path just keeps prose readable in production.
  if (!entry) {
    return <span style={style}>{children}</span>;
  }

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), LEAVE_GRACE_MS);
  };

  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
      }}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={open ? popoverId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          // Local Escape handler — closes the popover without needing
          // a window-level listener. Tested via fireEvent.keyDown on
          // the button itself for predictable JSDOM behaviour.
          if (e.key === "Escape" && open) {
            e.preventDefault();
            setOpen(false);
          }
        }}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          margin: 0,
          color: "inherit",
          font: "inherit",
          textDecoration: "underline dotted",
          textDecorationColor: "var(--accent)",
          textUnderlineOffset: "2px",
          textDecorationThickness: "1px",
          cursor: "help",
          ...style,
        }}
      >
        {children}
      </button>
      {open && (
        <span
          id={popoverId}
          role="tooltip"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 6,
            zIndex: 50,
            minWidth: 240,
            maxWidth: 320,
            padding: "10px 12px",
            background: "var(--surface)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2)",
            boxShadow: "var(--shadow-2, 0 8px 24px rgba(0,0,0,0.18))",
            fontSize: "var(--fs-xs)",
            lineHeight: 1.45,
            color: "var(--ink-1)",
            textAlign: "left",
            whiteSpace: "normal",
            // Pull cursor-help out of the floating element so it doesn't
            // inherit the trigger's help cursor over body text.
            cursor: "auto",
          }}
        >
          <strong
            style={{
              display: "block",
              fontSize: "var(--fs-xs)",
              fontWeight: 600,
              color: "var(--accent)",
              marginBottom: 4,
            }}
          >
            {entry.term}
          </strong>
          <span style={{ color: "var(--ink-2)" }}>{entry.definition}</span>
          <Link
            href={entry.href}
            style={{
              display: "block",
              marginTop: 8,
              color: "var(--accent)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Learn more →
          </Link>
        </span>
      )}
    </span>
  );
}
