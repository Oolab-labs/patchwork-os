"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { useBridgeStatus, type BridgeStatus } from "@/hooks/useBridgeStatus";
import { isDemoMode, onDemoModeChange, setDemoMode } from "@/lib/demoMode";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { subscribeStreamLiveness } from "@/lib/streamLiveness";
import { getHaltsLookbackMs, subscribeHaltsSeen } from "@/lib/haltsSeen";
import { NAV_SECTIONS } from "@/lib/navRoutes";
import { ActivityTicker } from "./ActivityTicker";
import { BridgeOfflineBanner } from "./BridgeOfflineBanner";
import { CardGlow } from "./CardGlow";
import { CommandPalette } from "./CommandPalette";

// ------------------------------------------------------------------ icons

function NavIcon({ path }: { path: string }) {
  const paths = path.split(" M ").map((p, i) => (i === 0 ? p : "M " + p));
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}

const PATHS: Record<string, string> = {
  home:       "M3 12L12 3l9 9v8a1 1 0 01-1 1h-5v-5H9v5H4a1 1 0 01-1-1v-8z",
  inbox:      "M22 12H16l-2 3H10l-2-3H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z",
  activity:   "M22 12H18L15 21 9 3 6 12H2",
  check:      "M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z",
  tasks:      "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6M9 16h4",
  monitor:    "M2 3h20v14a2 2 0 01-2 2H4a2 2 0 01-2-2V3zM8 21h8M12 17v4",
  bar:        "M18 20V10M12 20V4M6 20V14",
  trending:   "M23 6L13.5 15.5 8.5 10.5 1 18M17 6h6v6",
  book:       "M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15zM12 7h5M12 11h5",
  store:      "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01",
  play:       "M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664zM21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  git:        "M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18",
  lightbulb:  "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z",
  plug:       "M7 22V11M17 22V11M5 11h14l-1.5-7h-11L5 11zM3 11h18",
  settings:   "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z",
  plus:       "M12 4v16m8-8H4",
  diff:       "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 12h6m-3-3v6",
  person:     "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  bookmark:   "M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z",
  chevron:    "M6 9l6 6 6-6",
};

// ------------------------------------------------------------------ brand logo

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="2" y="2" width="9" height="9" rx="1.5" fill="var(--accent)" />
        <rect x="13" y="2" width="9" height="9" rx="1.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" />
        <rect x="2" y="13" width="9" height="9" rx="1.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" />
        <rect x="13" y="13" width="9" height="9" rx="1.5" fill="var(--accent)" opacity="0.4" />
        <line className="brand-stitch" x1="11.5" y1="6.5" x2="13" y2="6.5" stroke="var(--accent)" strokeWidth="1.2" />
        <line className="brand-stitch" x1="11.5" y1="17.5" x2="13" y2="17.5" stroke="var(--accent)" strokeWidth="1.2" />
        <line className="brand-stitch" x1="6.5" y1="11.5" x2="6.5" y2="13" stroke="var(--accent)" strokeWidth="1.2" />
        <line className="brand-stitch" x1="17.5" y1="11.5" x2="17.5" y2="13" stroke="var(--accent)" strokeWidth="1.2" />
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ nav structure
//
// NAV_SECTIONS is now exported from src/lib/navRoutes.ts (single source
// of truth shared with CommandPalette + MobileBottomNav). The local
// rename + adapter keeps the existing JSX (which reads `section.items`)
// working without a sweeping rewrite of the render code.

type NavItem = {
  href: string;
  label: string;
  icon: string;
  badge?: "approvals" | "halts";
};

const SECTIONS: { title: string; items: NavItem[] }[] = NAV_SECTIONS.map((s) => ({
  title: s.title,
  items: s.routes.map((r) => ({
    href: r.href,
    label: r.label,
    icon: r.icon ?? "home",
    badge: r.badge,
  })),
}));

// ------------------------------------------------------------------ approval count

function useApprovalCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let sseLive = false;
    const BASE = 5000;
    /** Slow cadence while SSE is healthy — SSE pushes approval-decision
     *  events directly, so this becomes a periodic correctness check. */
    const SSE_LIVE = 30_000;
    const MAX = 30_000;

    const reschedule = (ms: number) => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (!alive) return;
      timerId = setTimeout(tick, ms);
    };

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        reschedule(BASE);
        return;
      }
      let ok = false;
      try {
        const res = await fetch(apiPath("/api/bridge/approvals"));
        if (res.ok) {
          const data = await res.json();
          if (alive && Array.isArray(data)) setCount(data.length);
          ok = true;
        }
      } catch { /* offline */ }
      if (ok) failures = 0;
      else failures++;
      const baseInterval = sseLive ? SSE_LIVE : BASE;
      const exp = Math.min(BASE * 2 ** failures, MAX);
      reschedule(ok ? baseInterval : exp * (0.8 + Math.random() * 0.4));
    };

    const unsubLiveness = subscribeStreamLiveness((live) => {
      const wasLive = sseLive;
      sseLive = live;
      // SSE just dropped — refresh now so the badge doesn't sit stale
      // for up to 30 s after the bridge goes offline.
      if (wasLive && !live) reschedule(0);
    });

    const onVisible = () => {
      if (!document.hidden && alive) {
        reschedule(0);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      alive = false;
      if (timerId !== null) clearTimeout(timerId);
      document.removeEventListener("visibilitychange", onVisible);
      unsubLiveness();
    };
  }, []);
  return count;
}

// ------------------------------------------------------------------ halt count

/**
 * Polls `/runs/halt-summary` for the count of halts since the user last
 * visited /activity (capped at 24h). Drives a small red badge on the
 * Activity nav item so users see new halt pressure from any page.
 *
 * Was previously a fixed 24h count which monotonically grew with no UI
 * to acknowledge — visiting /activity didn't dismiss it; the only "clear"
 * was waiting 24h. The lookback now shrinks to "since last visit" via
 * lib/haltsSeen, matching how every other notification badge behaves.
 *
 * Slower cadence than approvals (halts are post-hoc; no SSE), low priority.
 * Re-fetches immediately on `markHaltsSeen()` so the badge clears on
 * visit instead of waiting for the next 60s tick.
 */
function useHaltCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const PERIOD = 60_000; // 60s — halts are historical, no urgency

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        timerId = setTimeout(tick, PERIOD);
        return;
      }
      const sinceMs = getHaltsLookbackMs();
      // Lookback of 0 means the user just acknowledged; surface that as
      // an immediate zero instead of a pointless backend round-trip.
      if (sinceMs === 0) {
        if (alive) setCount(0);
        timerId = setTimeout(tick, PERIOD);
        return;
      }
      try {
        const res = await fetch(
          apiPath(`/api/bridge/runs/halt-summary?sinceMs=${sinceMs}`),
        );
        if (res.ok) {
          const data = (await res.json()) as { total?: number };
          if (alive) setCount(typeof data.total === "number" ? data.total : 0);
        }
      } catch {
        /* offline — leave count alone, don't flash to zero */
      }
      if (alive) timerId = setTimeout(tick, PERIOD);
    };

    tick();
    // Refetch immediately when any tab marks halts seen (covers same-tab
    // events; the `storage` listener below covers other tabs).
    const unsubSeen = subscribeHaltsSeen(() => {
      if (timerId !== null) clearTimeout(timerId);
      void tick();
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === "patchwork.haltsLastSeenAt") {
        if (timerId !== null) clearTimeout(timerId);
        void tick();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
    }
    return () => {
      alive = false;
      if (timerId !== null) clearTimeout(timerId);
      unsubSeen();
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
    };
  }, []);
  return count;
}

// ------------------------------------------------------------------ identity

function useIdentity(status: BridgeStatus): { user: string; host: string; port: number | undefined } {
  const port = status.patchwork?.port ?? status.port;
  const workspace = status.patchwork?.workspace ?? status.workspace ?? "";
  const wsName = workspace ? workspace.split("/").filter(Boolean).pop() ?? "local" : "local";
  // `process.env.USER` is the *server's* USER (whoever ran `npm run dev`),
  // not the user viewing the page. Reading it during render causes a
  // hydration mismatch ("wesh@local" SSR, "local@local" client) which
  // forces React to fall back to client-only rendering for the entire
  // tree. We always render "local" — this is a localhost dashboard and
  // the username has no semantic meaning here.
  const user = "local";
  return { user, host: `${user}@${wsName}`, port };
}

// ------------------------------------------------------------------ demo mode

function useDemo() {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    setDemo(isDemoMode());
    return onDemoModeChange(setDemo);
  }, []);
  const toggle = () => setDemoMode(!demo);
  return { demo, toggle };
}

// ------------------------------------------------------------------ theme

type ThemePref = "dark" | "paper";

function normalizeTheme(value: string | null): ThemePref {
  if (value === "paper" || value === "light") return "paper";
  return "dark";
}

function applyTheme(theme: ThemePref) {
  document.documentElement.setAttribute("data-theme", theme);
  document.body.dataset.theme = theme;
}

function useTheme() {
  const [active, setActive] = useState<ThemePref>("dark");
  useEffect(() => {
    const stored = normalizeTheme(
      localStorage.getItem("patchwork.theme") ?? localStorage.getItem("pw-theme"),
    );
    setActive(stored);
    applyTheme(stored);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "patchwork.theme") return;
      const next = normalizeTheme(e.newValue);
      setActive(next);
      applyTheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const toggle = () => {
    const next: ThemePref = active === "dark" ? "paper" : "dark";
    setActive(next);
    applyTheme(next);
    localStorage.setItem("patchwork.theme", next);
  };
  return { active, toggle };
}

// ------------------------------------------------------------------ shell

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const status = useBridgeStatus();
  const approvalCount = useApprovalCount();
  const haltCount = useHaltCount();
  const { active, toggle } = useTheme();
  const { demo, toggle: toggleDemo } = useDemo();
  const identity = useIdentity(status);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Demo: replace with real notification count when available
  const hasNotifications = approvalCount > 0;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
  }, [pathname]);

  // Drawer focus trap: lock body scroll, mark non-drawer regions inert,
  // cycle Tab inside the drawer, close on Escape. Selector excludes the
  // drawer itself (`.app-sidebar`) and its scrim (`.mobile-scrim`) so
  // both remain interactive while the rest of the app goes inert.
  useFocusTrap({
    open: mobileOpen,
    onClose: () => setMobileOpen(false),
    containerRef: drawerRef,
    inertSelector: "main, .app-header, .mobile-bottom-nav",
  });

  // Global ⌘K / Ctrl+K hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app-shell${mobileOpen ? " mobile-open" : ""}`}>
      <CardGlow />
      <button
        type="button"
        className="mobile-scrim"
        aria-label="Close navigation"
        onClick={() => setMobileOpen(false)}
        tabIndex={mobileOpen ? 0 : -1}
      />
      <header className="app-header">
        <div className="app-header-left">
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Link href="/" className="topbar-brand">
            <BrandMark />
            <span>
              Patchwork
              {/* "OS" suffix shown on desktop, dropped on mobile via the
                  .topbar-brand-suffix rule in globals.css. Keeps the
                  full wordmark on wide screens and the short form on
                  phones where horizontal room is tight. */}
              <span className="topbar-brand-suffix"> OS</span>
            </span>
            <span className="topbar-local">local</span>
          </Link>
        </div>
        <button
          type="button"
          className="topbar-search"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span className="topbar-search-placeholder">Jump to anything…</span>
          <span className="kbd">⌘K</span>
        </button>
        {/*
          Live activity ticker. Sits between the command-palette button
          and the right-side action cluster. Renders the last 3 events
          the bridge has emitted (tool calls, approval decisions,
          lifecycle events) with a live green pulse — gives the
          dashboard a "feels alive" axis on every page, not just on
          /activity. Hidden below the desktop breakpoint via CSS.
        */}
        <ActivityTicker />
        <div className="app-header-actions">
          <IdentityPill ok={status.ok} host={identity.host} port={identity.port} />
          {/*
            Hide the demo toggle when the bridge is live AND demo is off.
            Audit verified: the chip was previously visible unconditionally,
            which made users (with a working bridge) wonder why a "Demo"
            label was sitting in their topbar. Keep the chip visible when:
              - bridge offline (offers demo as fallback experience)
              - demo already enabled (so the user has a clear way to disable)
          */}
          {(!status.ok || demo) && (
          <button
            type="button"
            onClick={toggleDemo}
            title={demo ? "Disable demo mode" : "Enable demo mode (sample data)"}
            aria-label="Toggle demo mode"
            aria-pressed={demo}
            style={{
              // Min-height 32 px to satisfy WCAG 2.5.5 target size (was ~22 px).
              // Keep the pill aesthetic — increased vertical padding + explicit
              // min-height; horizontal stays narrow so it doesn't hog the bar.
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              minHeight: 32,
              fontSize: "var(--fs-2xs)",
              fontWeight: 600,
              padding: "0 12px",
              borderRadius: 999,
              border: `1px solid ${demo ? "var(--orange)" : "var(--line-2)"}`,
              background: demo ? "color-mix(in srgb, var(--orange) 12%, transparent)" : "transparent",
              color: demo ? "var(--orange)" : "var(--ink-2)",
              cursor: "pointer",
              transition: "background 150ms, border-color 150ms, color 150ms",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: demo ? "var(--orange)" : "var(--dot-muted)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            Demo
          </button>
          )}
          <button
            className="theme-toggle"
            onClick={toggle}
            title={`Theme: ${active} — click for ${active === "dark" ? "paper" : "dark"}`}
            aria-label={`Switch to ${active === "dark" ? "paper" : "dark"} theme`}
          >
            {active === "paper" ? (
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            ) : (
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            )}
          </button>
          <Link
            href="/approvals"
            className="topbar-icon-btn topbar-bell"
            aria-label={hasNotifications ? `Notifications: ${approvalCount} pending approval${approvalCount === 1 ? "" : "s"}` : "Notifications"}
            title={hasNotifications ? `${approvalCount} pending approval${approvalCount === 1 ? "" : "s"}` : "No pending approvals"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            {hasNotifications && <span className="topbar-bell-dot" aria-hidden="true" />}
          </Link>
          <Link
            href="/settings"
            className="topbar-avatar"
            aria-label="Settings"
            title={identity.host}
          >
            <span aria-hidden="true">{(identity.user[0] ?? "?").toUpperCase()}</span>
          </Link>
        </div>
      </header>
      {/*
        Drawer ARIA: at desktop width the sidebar is just a navigation
        landmark, but on mobile (≤768 px) it's a modal dialog —
        useFocusTrap inerts the rest of the app + locks scroll while
        it's open. Mirror that semantically with `role="dialog"` +
        `aria-modal` so screen readers announce "Primary navigation
        dialog" / "modal" instead of leaking it as just another
        landmark. `tabIndex={-1}` is needed for the focus trap to
        focus the container when there are no focusable children.

        Desktop screen readers don't see the dialog role as wrong —
        the drawer is always "open" at desktop, so behaving as a
        dialog with no dismiss path is benign. The inertSelector
        passed to useFocusTrap is `main, .app-header,
        .mobile-bottom-nav` which only fires on mobile because none
        of those targets actually go inert at desktop scope.
      */}
      <aside
        ref={drawerRef}
        className="app-sidebar"
        role="dialog"
        aria-modal={mobileOpen ? "true" : undefined}
        aria-label="Primary navigation"
        tabIndex={-1}
      >
        <Link href="/recipes/new" className="sidebar-create" style={{ textDecoration: "none" }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ position: "relative", zIndex: 1 }}>
            <path d={PATHS.plus} />
          </svg>
          <span style={{ position: "relative", zIndex: 1 }}>New recipe</span>
        </Link>

        <nav className="app-nav" aria-label="Main navigation">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="app-nav-section-label">{section.title}</div>
              {section.items.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname?.startsWith(item.href);
                const badgeCount =
                  item.badge === "approvals"
                    ? approvalCount
                    : item.badge === "halts"
                      ? haltCount
                      : 0;
                const badgeLabel =
                  item.badge === "approvals"
                    ? `${badgeCount} pending`
                    : `${badgeCount} new halt${badgeCount === 1 ? "" : "s"} since last visit`;
                const showBadge = !!item.badge && badgeCount > 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`app-nav-link${isActive ? " is-active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="app-nav-link-icon" aria-hidden="true">
                      <NavIcon path={PATHS[item.icon]} />
                    </span>
                    <span>{item.label}</span>
                    {showBadge && (
                      <span className="nav-badge" aria-label={badgeLabel}>
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}

        </nav>

        <BridgeStatusBlock status={status} />
      </aside>

      <main id="main-content" className="app-main" tabIndex={-1}>
        <BridgeOfflineBanner status={status} />
        <div className="app-content">{children}</div>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function IdentityPill({ ok, host, port }: { ok: boolean; host: string; port?: number }) {
  const portText = port ? `127.0.0.1:${port}` : "offline";
  return (
    <span
      className={`identity-pill${ok ? "" : " is-offline"}`}
      title={ok ? `Connected to ${host} on ${portText}` : "Bridge offline"}
    >
      <span className={`identity-pill-dot${ok ? " online" : ""}`} aria-hidden="true" />
      <span className="sr-only">Bridge {ok ? "online" : "offline"}.</span>
      <span className="identity-pill-host">{host}</span>
      <span className="identity-pill-sep" aria-hidden="true">·</span>
      <span className="identity-pill-port">{portText}</span>
    </span>
  );
}

function BridgeStatusBlock({ status }: { status: BridgeStatus }) {
  const port = status.patchwork?.port ?? status.port;
  const version = status.patchwork?.version;
  return (
    <div className="app-sidebar-bridge" role="status" aria-label="Bridge status">
      <div className="app-sidebar-bridge-row">
        <span className="app-sidebar-bridge-label">Bridge</span>
        <span
          className={`app-sidebar-bridge-dot ${status.ok ? "online" : "offline"}`}
          aria-hidden="true"
          title={status.ok ? "online" : "offline"}
        />
        <span className="sr-only">{status.ok ? "online" : "offline"}</span>
      </div>
      <div className="app-sidebar-bridge-meta">
        <span className="app-sidebar-bridge-version">
          {version ? `v${version}` : "patchwork"}
        </span>
        <span className="app-sidebar-bridge-port">{port ? `:${port}` : "—"}</span>
      </div>
    </div>
  );
}
