"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/analytics", label: "Overview", description: "Tool usage & error rates" },
  { href: "/insights", label: "Insights", description: "Approval heuristics & trust patterns" },
  { href: "/metrics", label: "Metrics", description: "Prometheus counters & gauges" },
];

export function AnalyticsTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="cluster-tabs" aria-label="Analytics section">
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
