"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { useBridgeStatus, type BridgeStatus } from "@/hooks/useBridgeStatus";
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

type NavItem = { href: string; label: string; icon: string; badge?: boolean };

const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Workspace",
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
      { href: "/recipes",     label: "Recipes",     icon: "book" },
      { href: "/marketplace", label: "Marketplace", icon: "store" },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/analytics",  label: "Analytics",  icon: "trending" },
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

const MORE_ITEMS: NavItem[] = [
  { href: "/transactions", label: "Transactions", icon: "diff" },
];

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

// ------------------------------------------------------------------ theme

type ThemePref = "system" | "dark" | "paper";

function normalizeTheme(value: string | null): ThemePref {
  if (value === "dark" || value === "paper" || value === "system") return value;
  if (value === "light") return "paper";
  return "system";
}

function systemTheme(): Exclude<ThemePref, "system"> {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "paper" : "dark";
}

function applyTheme(theme: Exclude<ThemePref, "system">) {
  document.documentElement.setAttribute("data-theme", theme);
  document.body.dataset.theme = theme;
}

function useTheme() {
  const [pref, setPref] = useState<ThemePref>("system");
  const [active, setActive] = useState<Exclude<ThemePref, "system">>("dark");
  useEffect(() => {
    const stored = normalizeTheme(localStorage.getItem("patchwork.theme") ?? localStorage.getItem("pw-theme"));
    const resolved = stored === "system" ? systemTheme() : stored;
    setPref(stored);
    setActive(resolved);
    applyTheme(resolved);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (localStorage.getItem("patchwork.theme") === "system" || !localStorage.getItem("patchwork.theme")) {
        const next = systemTheme();
        setActive(next);
        applyTheme(next);
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  const toggle = () => {
    const nextPref: ThemePref = pref === "system" ? "dark" : pref === "dark" ? "paper" : "system";
    const resolved = nextPref === "system" ? systemTheme() : nextPref;
    setPref(nextPref);
    setActive(resolved);
    applyTheme(resolved);
    localStorage.setItem("patchwork.theme", nextPref);
  };
  return { active, pref, toggle };
}

// ------------------------------------------------------------------ shell

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const status = useBridgeStatus();
  const approvalCount = useApprovalCount();
  const { active, pref, toggle } = useTheme();
  const identity = useIdentity(status);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(() =>
    MORE_ITEMS.some((it) => typeof window !== "undefined" && window.location?.pathname?.startsWith(it.href))
  );
  // Demo: replace with real notification count when available
  const hasNotifications = approvalCount > 0;
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
  }, [pathname]);

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

  // Auto-expand More if we navigate into one of its routes
  useEffect(() => {
    if (MORE_ITEMS.some((it) => pathname?.startsWith(it.href))) setMoreOpen(true);
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
            <span>Patchwork OS</span>
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
        <div className="app-header-actions">
          <IdentityPill ok={status.ok} host={identity.host} port={identity.port} />
          <button
            className="theme-toggle"
            onClick={toggle}
            title={`Theme: ${pref}${pref === "system" ? ` (${active})` : ""}`}
            aria-label="Cycle theme"
          >
            {active === "paper" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            )}
            {pref === "system" && <span className="theme-toggle-auto" aria-hidden="true">auto</span>}
          </button>
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label="Open terminal"
            title="Terminal"
          >
            <span aria-hidden="true" style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, letterSpacing: "-0.05em" }}>
              {">_"}
            </span>
          </button>
          <button
            type="button"
            className="topbar-icon-btn topbar-bell"
            aria-label={hasNotifications ? "Notifications (unread)" : "Notifications"}
            title="Notifications"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            {hasNotifications && <span className="topbar-bell-dot" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="topbar-avatar"
            aria-label="Account"
            title={identity.host}
          >
            <span aria-hidden="true">{(identity.user[0] ?? "?").toUpperCase()}</span>
          </button>
        </div>
      </header>
      <aside className="app-sidebar" aria-label="Primary navigation">
        <Link href="/recipes/new" className="sidebar-create" style={{ textDecoration: "none" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ position: "relative", zIndex: 1 }}>
            <path d={PATHS.plus} />
          </svg>
          <span style={{ position: "relative", zIndex: 1 }}>New recipe</span>
        </Link>

        <nav className="app-nav" aria-label="Main navigation">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="app-nav-section-label">{section.title}</div>
              {section.items.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname?.startsWith(item.href);
                const showBadge = item.badge && approvalCount > 0;
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
                      <span className="nav-badge" aria-label={`${approvalCount} pending`}>
                        {approvalCount > 99 ? "99+" : approvalCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}

          <div className="app-nav-more">
            <button
              type="button"
              className="app-nav-link app-nav-more-toggle"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span className="app-nav-link-icon" aria-hidden="true">
                <NavIcon path={PATHS.chevron} />
              </span>
              <span>More</span>
              <span
                className="app-nav-more-caret"
                data-open={moreOpen ? "1" : "0"}
                aria-hidden="true"
              >
                <NavIcon path={PATHS.chevron} />
              </span>
            </button>
            {moreOpen && (
              <div className="app-nav-more-items">
                {MORE_ITEMS.map((item) => {
                  const isActive = pathname?.startsWith(item.href);
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
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </nav>

        <BridgeStatusBlock status={status} />
      </aside>

      <main id="main-content" className="app-main" tabIndex={-1}>
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
