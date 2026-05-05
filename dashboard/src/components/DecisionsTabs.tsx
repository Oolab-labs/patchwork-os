"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/approvals", label: "Pending", description: "Tool calls awaiting your nod" },
  { href: "/suggestions", label: "Suggested", description: "Proposed allow/deny rules" },
  { href: "/decisions", label: "History", description: "Past approvals & rejections" },
];

export function DecisionsTabs({ pendingCount }: { pendingCount?: number }) {
  const pathname = usePathname() ?? "";
  return (
    <nav className="cluster-tabs" aria-label="Decisions section">
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
            {t.href === "/approvals" && typeof pendingCount === "number" && pendingCount > 0 && (
              <span className="cluster-tab-badge">{pendingCount}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
