"use client";
import { useEffect } from "react";

const CARD_SELECTOR = ".card, .stat-card, .glass-card, .template-card";

/**
 * Hover-following gradient on cards. Was firing on every mousemove event
 * (potentially 1000+/sec while moving the mouse), each call doing a DOM
 * walk + getBoundingClientRect + two style writes. Now coalesced to one
 * write per animation frame so the rest of the page can paint.
 */
export function CardGlow() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let pendingEvent: MouseEvent | null = null;

    function flush() {
      raf = 0;
      const e = pendingEvent;
      pendingEvent = null;
      if (!e) return;
      const card = (e.target as Element | null)?.closest(CARD_SELECTOR) as HTMLElement | null;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty("--mouse-x", `${x}%`);
      card.style.setProperty("--mouse-y", `${y}%`);
    }

    function onMove(e: MouseEvent) {
      pendingEvent = e;
      if (raf === 0) raf = requestAnimationFrame(flush);
    }

    document.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      document.removeEventListener("mousemove", onMove);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
