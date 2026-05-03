"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { fmtDuration } from "./time";
import { apiPath } from "@/lib/api";
import { useBridgeStatus, type BridgeStatus } from "@/hooks/useBridgeStatus";
import { isDemoMode, setDemoMode, onDemoModeChange } from "@/lib/demoMode";
import { CardGlow } from "./CardGlow";

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
};

// ------------------------------------------------------------------ brand logo

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="2" y="2"  width="12" height="12" rx="3" fill="var(--orange)" />
      <rect x="18" y="2" width="12" height="12" rx="3" fill="var(--orange)" opacity="0.7" />
      <rect x="2" y="18" width="12" height="12" rx="3" fill="var(--orange)" opacity="0.7" />
      <rect x="18" y="18" width="12" height="12" rx="3" fill="var(--orange)" opacity="0.4" />
    </svg>
  );
}

// ------------------------------------------------------------------ nav structure

type NavItem = { href: string; label: string; icon: string; badge?: boolean };

const NAV_SECTIONS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/",           label: "Overview",    icon: "home" },
      { href: "/inbox",      label: "Inbox",       icon: "inbox" },
      { href: "/approvals",  label: "Approvals",   icon: "check",  badge: true },
      { href: "/activity",   label: "Activity",    icon: "activity" },
    ],
  },
  {
    title: "Automation",
    items: [
      { href: "/recipes",              label: "Recipes",      icon: "book" },
      { href: "/marketplace",           label: "Marketplace",  icon: "store" },
      { href: "/tasks",                label: "Tasks",        icon: "tasks" },
      { href: "/runs",                 label: "Runs",         icon: "play" },
      { href: "/transactions",         label: "Transactions", icon: "diff" },
      { href: "/suggestions",          label: "Suggestions",  icon: "lightbulb" },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/sessions",   label: "Sessions",   icon: "monitor" },
      { href: "/metrics",    label: "Metrics",    icon: "bar" },
      { href: "/analytics",  label: "Analytics",  icon: "trending" },
      { href: "/traces",     label: "Traces",     icon: "git" },
      { href: "/decisions",  label: "Decisions",  icon: "lightbulb" },
      { href: "/insights",   label: "Insights",   icon: "person" },
    ],
  },
  {
    title: "Setup",
    items: [
      { href: "/connections", label: "Connections", icon: "plug" },
      { href: "/settings",    label: "Settings",    icon: "settings" },
    ],
  },
];

const ALL_NAV = NAV_SECTIONS.flatMap((s) => s.items);

// ------------------------------------------------------------------ bridge status (hook imported from @/hooks/useBridgeStatus)

// ------------------------------------------------------------------ approval count

function useApprovalCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let failures = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const BASE = 5000;
    const MAX = 30_000;

    const schedule = (ms: number) => {
      if (!alive) return;
      timerId = setTimeout(tick, ms);
    };

    const tick = async () => {
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
      // Exponential backoff with ±20% jitter, cap 30s
      const exp = Math.min(BASE * 2 ** failures, MAX);
      schedule(ok ? BASE : exp * (0.8 + Math.random() * 0.4));
    };

    tick();
    return () => {
      alive = false;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, []);
  return count;
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

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("pw-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = stored ? stored === "dark" : prefersDark;
    setDark(isDark);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    localStorage.setItem("pw-theme", next ? "dark" : "light");
  };
  return { dark, toggle };
}

// ------------------------------------------------------------------ topbar nav

function TopbarNav({ pathname }: { pathname: string }) {
  const section = NAV_SECTIONS.find((s) =>
    s.items.some((item) =>
      item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href)
    )
  );
  if (!section || !section.title) return null;

  return (
    <nav className="topbar-nav" aria-label="Section navigation">
      {section.items.map((item) => {
        const active = item.href === "/"
          ? pathname === "/"
          : pathname?.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`topbar-link${active ? " is-active" : ""}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

// ------------------------------------------------------------------ shell

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const status = useBridgeStatus();
  const approvalCount = useApprovalCount();
  const { dark, toggle } = useTheme();
  const { demo, toggle: toggleDemo } = useDemo();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

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
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="app-brand">
          <BrandMark />
          <span>patchwork</span>
        </div>

        <Link href="/recipes/new" className="sidebar-create" style={{ textDecoration: "none" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ position: "relative", zIndex: 1 }}>
            <path d={PATHS.plus} />
          </svg>
          <span style={{ position: "relative", zIndex: 1 }}>New recipe</span>
        </Link>

        <nav className="app-nav" aria-label="Main navigation">
          {NAV_SECTIONS.map((section, si) => (
            <div key={si}>
              {section.title && (
                <div className="app-nav-section-label">{section.title}</div>
              )}
              {section.items.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname?.startsWith(item.href);
                const showBadge = item.badge && approvalCount > 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`app-nav-link${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="app-nav-link-icon" aria-hidden="true">
                      <NavIcon path={PATHS[item.icon]} />
                    </span>
                    <span>{item.label}</span>
                    {showBadge && (
                      <span className="nav-badge" aria-label={`${approvalCount} pending`}>
                        {approvalCount > 99 ? "99+" : approvalCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="app-sidebar-footer">
          <span
            className={`app-sidebar-footer-dot ${status.ok ? "online" : "offline"}`}
            aria-hidden="true"
          />
          <span>{status.ok ? "Bridge online" : "Bridge offline"}</span>
        </div>
      </aside>

      <div className="app-main">
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
            <div className="app-header-title">{pageTitle(pathname ?? "/")}</div>
            <TopbarNav pathname={pathname ?? "/"} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={toggleDemo}
              title={demo ? "Disable demo mode" : "Enable demo mode"}
              aria-label="Toggle demo mode"
              style={{
                display: "flex", alignItems: "center", gap: 5,
                fontSize: 11, fontWeight: 600,
                padding: "4px 10px", borderRadius: "var(--r-full)",
                border: `1px solid ${demo ? "rgba(216,119,87,0.35)" : "var(--line-2)"}`,
                background: demo ? "rgba(216,119,87,0.10)" : "transparent",
                color: demo ? "var(--orange)" : "var(--ink-2)",
                cursor: "pointer", transition: "all 150ms",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: demo ? "var(--orange)" : "var(--ink-3)", display: "inline-block", flexShrink: 0 }} />
              Demo
            </button>
            <button
              className="theme-toggle"
              onClick={toggle}
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              {dark ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                </svg>
              )}
            </button>
            <BridgePill status={status} />
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

function pageTitle(pathname: string): string {
  const matches = ALL_NAV.filter((n) =>
    n.href === "/" ? pathname === "/" : pathname.startsWith(n.href),
  );
  const entry = matches.reduce<(typeof ALL_NAV)[0] | undefined>(
    (best, n) => (!best || n.href.length > best.href.length ? n : best),
    undefined,
  );
  return entry?.label ?? "Patchwork";
}

function BridgePill({ status }: { status: BridgeStatus }) {
  if (!status.ok) {
    return (
      <span className="pill err" style={{ borderRadius: 6 }} title="Bridge unreachable">
        <span className="pill-dot" />
        Bridge offline
      </span>
    );
  }
  const port = status.patchwork?.port ?? status.port;
  const clients = status.activeSessions ?? "–";
  const uptime = status.uptimeMs != null ? fmtDuration(status.uptimeMs) : "–";
  const tooltip = `Port :${port ?? "–"} · ${clients} session(s) · uptime ${uptime}`;
  const label = port ? `Connected · :${port}` : "Connected";
  return (
    <span className="bridge-status-pill" title={tooltip}>
      <span className="bridge-status-dot" />
      {label}
    </span>
  );
}
