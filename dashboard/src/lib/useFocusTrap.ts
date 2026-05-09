"use client";

import { type RefObject, useEffect, useRef } from "react";

/**
 * Focus-trap hook for mobile drawers, sheets, and modals.
 *
 * Mirrors `Dialog.tsx`'s integrated trap behavior, but factored out so
 * non-portal containers can opt in. The Dialog component portals into
 * `body` and marks `[data-app-root]` inert — a pattern that doesn't
 * compose for in-tree containers (the mobile drawer is a child of
 * data-app-root; marking the root inert would inert the drawer too).
 *
 * While `open` is true:
 *   - Move focus to the first focusable element inside `containerRef`.
 *   - Cycle Tab / Shift+Tab to keep focus inside the container.
 *   - Escape calls `onClose`.
 *   - Lock `document.body` scroll (unless `lockScroll: false`).
 *   - Mark elements matching `inertSelector` as `inert` + `aria-hidden`.
 *
 * On close: restore focus to the element that had it before open.
 */

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

interface FocusTrapOptions {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  /**
   * CSS selector for elements to mark inert + aria-hidden while open.
   * Default `"[data-app-root]"` (correct for portaled dialogs).
   *
   * For in-tree containers, pass a selector that EXCLUDES the trap
   * container itself, e.g. `"main, .app-header, .mobile-bottom-nav"`
   * for a sidebar drawer that lives inside data-app-root.
   */
  inertSelector?: string;
  /** Lock body scroll while open. Default true. */
  lockScroll?: boolean;
}

export function useFocusTrap({
  open,
  onClose,
  containerRef,
  inertSelector = "[data-app-root]",
  lockScroll = true,
}: FocusTrapOptions) {
  const previousActiveRef = useRef<HTMLElement | null>(null);

  // Capture the previously-focused element BEFORE trap-driven focus
  // moves run. Idempotent across renders within one open cycle.
  if (
    open &&
    previousActiveRef.current === null &&
    typeof document !== "undefined"
  ) {
    const active = document.activeElement as HTMLElement | null;
    if (active && !containerRef.current?.contains(active)) {
      previousActiveRef.current = active;
    }
  }

  // Move focus into the container on open; restore on close.
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    const focusables =
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    const target = focusables[0] ?? container;
    target.focus({ preventScroll: true });
    return () => {
      const restore = previousActiveRef.current;
      previousActiveRef.current = null;
      restore?.focus?.({ preventScroll: true });
    };
  }, [open, containerRef]);

  // Body scroll lock + sibling inert / aria-hidden.
  useEffect(() => {
    if (!open) return;
    let prevOverflow = "";
    if (lockScroll) {
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const inertEls = Array.from(
      document.querySelectorAll<HTMLElement>(inertSelector),
    );
    for (const el of inertEls) {
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    }
    return () => {
      if (lockScroll) {
        document.body.style.overflow = prevOverflow;
      }
      for (const el of inertEls) {
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
      }
    };
  }, [open, lockScroll, inertSelector]);

  // Tab cycling + Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const nodes = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((n) => !n.hasAttribute("aria-hidden"));
      if (nodes.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || (active && !container.contains(active))) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, containerRef]);
}
