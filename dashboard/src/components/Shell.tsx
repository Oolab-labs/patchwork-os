"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "./time";
import { apiPath } from "@/lib/api";

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
  home:       "M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z M9 21V12h6v9",
  inbox:      "M22 12H16L14 15H10L8 12H2 M5.45 5.11L2 12V18a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z",
  activity:   "M22 12H18L15 21 9 3 6 12H2",
  check:      "M22 11.08V12a10 10 0 11-5.93-9.14 M22 4L12 14.01 9 11.01",
  tasks:      "M3 5h6v6H3z M3 17l2 2 4-4 M13 6h8 M13 12h8 M13 18h8",
  monitor:    "M2 3h20v14a2 2 0 01-2 2H4a2 2 0 01-2-2V3z M8 21h8 M12 17v4",
  bar:        "M18 20V10 M12 20V4 M6 20V14",
  trending:   "M23 6L13.5 15.5 8.5 10.5 1 18 M17 6h6v6",
  book:       "M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z",
  store:      "M3 9h18l-1.5 9a2 2 0 01-2 1.5H6.5a2 2 0 01-2-1.5L3 9z M3 9l2-5h14l2 5 M12 4v5",
  play:       "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M10 8l6 4-6 4V8z",
  git:        "M6 3v12 M18 9a3 3 0 100-6 3 3 0 000 6z M6 21a3 3 0 100-6 3 3 0 000 6z M18 9a9 9 0 01-9 9",
  lightbulb:  "M9 18h6 M10 22h4 M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14",
  plug:       "M12 22v-5 M9 8V2 M15 8V2 M18 8H6a2 2 0 00-2 2v2a6 6 0 0012 0v-2a2 2 0 00-2-2z",
  settings:   "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  plus:       "M12 5v14 M5 12h14",
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
      { href: "/recipes/marketplace",  label: "Marketplace",  icon: "store" },
      { href: "/tasks",                label: "Tasks",        icon: "tasks" },
      { href: "/runs",                 label: "Runs",         icon: "play" },
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

// ------------------------------------------------------------------ bridge status

interface BridgeStatus {
  ok: boolean;
  port?: number;
  workspace?: string;
  extensionConnected?: boolean;
  slim?: boolean;
  approvalGate?: string;
  uptimeMs?: number;
  activeSessions?: number;
  patchwork?: { port?: number; workspace?: string; approvalGate?: string };
}

function useBridgeStatus(): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>({ ok: false });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/status"));
        if (!res.ok) throw new Error(`status ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json") && !ct.includes("text/plain")) throw new Error("bad content-type");
        const data = (await res.json()) as Partial<BridgeStatus>;
        if (alive) setStatus({ ok: true, ...data });
      } catch {
        try {
          const res = await fetch(apiPath("/api/bridge/approvals"));
          const ct = res.headers.get("content-type") ?? "";
          if (alive) setStatus({ ok: res.ok && ct.includes("application/json") });
        } catch {
          if (alive) setStatus({ ok: false });
        }
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return status;
}

// ------------------------------------------------------------------ approval count

function useApprovalCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/approvals"));
        if (!res.ok) return;
        const data = await res.json();
        if (alive && Array.isArray(data)) setCount(data.length);
      } catch { /* offline */ }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return count;
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

// ------------------------------------------------------------------ mouse glow

function useCardMouseGlow() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const card = (e.target as Element).closest<HTMLElement>(".card, .stat-card, .approval, .glass-card");
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
      card.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
    };
    document.addEventListener("mousemove", handler);
    return () => document.removeEventListener("mousemove", handler);
  }, []);
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
  useCardMouseGlow();

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="app-brand">
          <BrandMark />
          <span>patchwork</span>
        </div>

        <button className="sidebar-create" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d={PATHS.plus} />
          </svg>
          Create
        </button>

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
            <div className="app-header-title">{pageTitle(pathname ?? "/")}</div>
            <TopbarNav pathname={pathname ?? "/"} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
