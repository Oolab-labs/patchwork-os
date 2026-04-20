"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { fmtDuration } from "./time";

// ------------------------------------------------------------------ icons

function IconHome() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z" />
      <path d="M9 21V12h6v9" />
    </svg>
  );
}

function IconInbox() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function IconCheckCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconListTodo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="m3 17 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  );
}

function IconMonitor() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function IconBarChart2() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function IconTrendingUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  );
}

function IconBookOpen() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function IconPlayCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  );
}

function IconGitBranch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function IconLightbulb() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="9" y1="18" x2="15" y2="18" />
      <line x1="10" y1="22" x2="14" y2="22" />
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
    </svg>
  );
}

function IconPlug() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8H6a2 2 0 0 0-2 2v2a6 6 0 0 0 12 0v-2a2 2 0 0 0-2-2z" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// ------------------------------------------------------------------ nav

const NAV: { href: string; label: string; icon: ReactNode }[] = [
  { href: "/", label: "Overview", icon: <IconHome /> },
  { href: "/inbox", label: "Inbox", icon: <IconInbox /> },
  { href: "/activity", label: "Activity", icon: <IconActivity /> },
  { href: "/approvals", label: "Approvals", icon: <IconCheckCircle /> },
  { href: "/tasks", label: "Tasks", icon: <IconListTodo /> },
  { href: "/sessions", label: "Sessions", icon: <IconMonitor /> },
  { href: "/metrics", label: "Metrics", icon: <IconBarChart2 /> },
  { href: "/analytics", label: "Analytics", icon: <IconTrendingUp /> },
  { href: "/recipes", label: "Recipes", icon: <IconBookOpen /> },
  { href: "/runs", label: "Runs", icon: <IconPlayCircle /> },
  { href: "/traces", label: "Traces", icon: <IconGitBranch /> },
  { href: "/decisions", label: "Decisions", icon: <IconLightbulb /> },
  { href: "/connections", label: "Connections", icon: <IconPlug /> },
  { href: "/settings", label: "Settings", icon: <IconSettings /> },
];

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
  patchwork?: {
    port?: number;
    workspace?: string;
    approvalGate?: string;
  };
}

function useBridgeStatus(): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>({ ok: false });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/bridge/status");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as Partial<BridgeStatus>;
        if (alive) setStatus({ ok: true, ...data });
      } catch {
        try {
          const res = await fetch("/api/bridge/approvals");
          if (alive) setStatus({ ok: res.ok });
        } catch {
          if (alive) setStatus({ ok: false });
        }
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return status;
}

// ------------------------------------------------------------------ shell

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const status = useBridgeStatus();

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Primary">
        <div className="app-brand">
          <span className="app-brand-dot" aria-hidden="true" />
          <span>patchwork</span>
        </div>
        <nav className="app-nav" aria-label="Main navigation">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-nav-link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="app-nav-link-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="app-sidebar-footer">Patchwork OS · oversight v0.1</div>
      </aside>

      <div className="app-main">
        <header className="app-header">
          <div className="app-header-title">{pageTitle(pathname ?? "/")}</div>
          <BridgePill status={status} />
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

function pageTitle(pathname: string): string {
  const entry = NAV.find((n) =>
    n.href === "/" ? pathname === "/" : pathname.startsWith(n.href),
  );
  return entry?.label ?? "Patchwork";
}

function BridgePill({ status }: { status: BridgeStatus }) {
  if (!status.ok) {
    return (
      <span className="pill err" title="Bridge unreachable">
        <span className="pill-dot" />
        Bridge offline
      </span>
    );
  }

  const port = status.patchwork?.port ?? status.port;
  const clients = status.activeSessions ?? "–";
  const uptime = status.uptimeMs != null ? fmtDuration(status.uptimeMs) : "–";
  const tooltip = `Port :${port ?? "–"} • ${clients} session(s) • uptime ${uptime}`;
  const label = port ? `Connected · :${port}` : "Connected to bridge";

  return (
    <span className="pill ok" title={tooltip}>
      <span
        className="pill-dot"
        style={{ animation: "pulse-dot 2s ease-in-out infinite" }}
      />
      {label}
    </span>
  );
}
