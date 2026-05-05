"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface BottomNavItem {
  href: string;
  label: string;
  d: string;
  match?: (pathname: string) => boolean;
}

const PRIMARY: BottomNavItem[] = [
  { href: "/",          label: "Overview",  d: "M3 12L12 3l9 9v8a1 1 0 01-1 1h-5v-5H9v5H4a1 1 0 01-1-1v-8z", match: (p) => p === "/" },
  { href: "/inbox",     label: "Inbox",     d: "M22 12H16l-2 3H10l-2-3H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" },
  { href: "/approvals", label: "Approvals", d: "M9 12l2 2 4-4M22 12a10 10 0 11-20 0 10 10 0 0120 0z" },
  { href: "/activity",  label: "Activity",  d: "M22 12H18L15 21 9 3 6 12H2" },
];

const MORE_LINKS: { href: string; label: string }[] = [
  { href: "/recipes", label: "Recipes" },
  { href: "/runs", label: "Runs" },
  { href: "/tasks", label: "Tasks" },
  { href: "/sessions", label: "Sessions" },
  { href: "/traces", label: "Traces" },
  { href: "/decisions", label: "Decisions" },
  { href: "/suggestions", label: "Suggestions" },
  { href: "/analytics", label: "Analytics" },
  { href: "/insights", label: "Insights" },
  { href: "/metrics", label: "Metrics" },
  { href: "/transactions", label: "Transactions" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/connections", label: "Connections" },
  { href: "/settings", label: "Settings" },
];

const MORE_ICON = "M12 6h.01M12 12h.01M12 18h.01";

export function MobileBottomNav() {
  const pathname = usePathname() ?? "/";
  const [sheetOpen, setSheetOpen] = useState(false);

  // Close on route change
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  // Close on Escape
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const moreActive = MORE_LINKS.some((l) => pathname.startsWith(l.href));

  return (
    <>
      <nav className="mobile-bottom-nav" aria-label="Primary">
        {PRIMARY.map((item) => {
          const isActive = item.match
            ? item.match(pathname)
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mobile-bottom-nav-item${isActive ? " is-active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={item.d} />
              </svg>
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={`mobile-bottom-nav-item${moreActive && !sheetOpen ? " is-active" : ""}`}
          onClick={() => setSheetOpen((v) => !v)}
          aria-expanded={sheetOpen}
          aria-controls="mobile-more-sheet"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={MORE_ICON} />
          </svg>
          <span>More</span>
        </button>
      </nav>

      {sheetOpen && (
        <>
          <button
            type="button"
            className="mobile-more-backdrop"
            aria-label="Close menu"
            onClick={() => setSheetOpen(false)}
          />
          <div
            id="mobile-more-sheet"
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More navigation"
          >
            <div className="mobile-more-sheet-handle" aria-hidden="true" />
            <div className="mobile-more-sheet-grid">
              {MORE_LINKS.map((l) => {
                const isActive = pathname.startsWith(l.href);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={`mobile-more-sheet-item${isActive ? " is-active" : ""}`}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
