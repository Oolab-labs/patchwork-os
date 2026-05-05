"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/activity", label: "Live", description: "Streaming event feed" },
  { href: "/runs", label: "Runs", description: "Recipe runs" },
  { href: "/tasks", label: "Tasks", description: "Claude orchestrator tasks" },
  { href: "/sessions", label: "Sessions", description: "Connected clients" },
  { href: "/traces", label: "Traces", description: "Decision & recipe traces" },
];

export function ActivityTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="cluster-tabs" aria-label="Activity section">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`cluster-tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            title={t.description}
          >
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
