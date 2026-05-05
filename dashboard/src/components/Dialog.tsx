"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  children: ReactNode;
  /** Optional max width for the panel; defaults to 480px. */
  maxWidth?: number | string;
  /** Whether clicking the backdrop closes the dialog. Default true. */
  dismissOnBackdrop?: boolean;
  panelStyle?: CSSProperties;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "audio[controls]",
  "video[controls]",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(",");

export function Dialog({
  open,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  children,
  maxWidth = 480,
  dismissOnBackdrop = true,
  panelStyle,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const fallbackId = useId();

  // Capture the previously-focused element BEFORE the dialog renders so that
  // a rapid open/close/open sequence doesn't end up storing the dialog itself
  // as the "previous" element.
  if (open && previousActiveRef.current === null) {
    const active = document.activeElement as HTMLElement | null;
    if (active && !panelRef.current?.contains(active)) {
      previousActiveRef.current = active;
    }
  }

  // Move focus into panel on open; restore on close.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    const target = focusables[0] ?? panel;
    target.focus({ preventScroll: true });
    return () => {
      const restore = previousActiveRef.current;
      previousActiveRef.current = null;
      restore?.focus?.({ preventScroll: true });
    };
  }, [open]);

  // Prevent body scroll while open + mark the rest of the app inert.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const main = document.querySelector<HTMLElement>("[data-app-root]");
    if (main) {
      main.setAttribute("inert", "");
      main.setAttribute("aria-hidden", "true");
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      if (main) {
        main.removeAttribute("inert");
        main.removeAttribute("aria-hidden");
      }
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((n) => !n.hasAttribute("aria-hidden"));
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay-bg, rgba(10, 11, 13, 0.55))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "var(--s-4, 16px)",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        id={fallbackId}
        style={{
          background: "var(--surface)",
          color: "var(--ink-0)",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--r-2, 10px)",
          boxShadow: "var(--shadow-modal)",
          padding: "var(--s-5, 20px)",
          width: "100%",
          maxWidth,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
