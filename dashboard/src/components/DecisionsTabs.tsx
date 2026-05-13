"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// IA correction (2026-05-12): the third tab used to be labelled "History"
// with description "Past approvals & rejections", but the /decisions page
// actually renders the ctxSaveTrace knowledge base — the saved reasoning
// behind decisions, not a chronological approval log. The mislabel was the
// single most disorienting IA bug per the dashboard audit. Renamed to
// "Knowledge" to match what the page actually shows.
const TABS = [
  { href: "/approvals", label: "Pending", description: "Tool calls awaiting your nod" },
  { href: "/suggestions", label: "Suggested", description: "Proposed allow/deny rules" },
  { href: "/decisions", label: "Knowledge", description: "Reasoning your agents have written down" },
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
