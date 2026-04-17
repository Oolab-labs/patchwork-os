"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/", label: "Overview", icon: "\u25A3" },
  { href: "/activity", label: "Activity", icon: "\u2248" },
  { href: "/approvals", label: "Approvals", icon: "\u2713" },
  { href: "/tasks", label: "Tasks", icon: "\u25B8" },
  { href: "/sessions", label: "Sessions", icon: "\u2295" },
  { href: "/metrics", label: "Metrics", icon: "\u25B4" },
  { href: "/analytics", label: "Analytics", icon: "\u25CE" },
  { href: "/recipes", label: "Recipes", icon: "\u25C9" },
  { href: "/runs", label: "Runs", icon: "\u29D6" },
  { href: "/settings", label: "Settings", icon: "\u2699" },
];

interface BridgeStatus {
  ok: boolean;
  port?: number;
  workspace?: string;
  extensionConnected?: boolean;
  slim?: boolean;
  approvalGate?: string;
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
        // fallback: hit approvals as a liveness ping
        try {
          const res = await fetch("/api/bridge/approvals");
          if (alive) setStatus({ ok: res.ok, ...(res.ok ? {} : {}) });
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
  const label = status.port
    ? `Connected · :${status.port}`
    : "Connected to bridge";
  return (
    <span className="pill ok" title={status.workspace ?? ""}>
      <span className="pill-dot" />
      {label}
    </span>
  );
}
