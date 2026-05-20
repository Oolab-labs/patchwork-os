"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { MOBILE_PRIMARY_HREFS, findRoute, moreRoutes } from "@/lib/navRoutes";
import { useHaltCount } from "./Shell";

interface BottomNavItem {
  href: string;
  label: string;
  d: string;
  match?: (pathname: string) => boolean;
}

/**
 * Mobile bottom-tab SVG paths. Kept here (not in navRoutes) because
 * these are full mobile-sized icons (24×24, single-path-per-glyph)
 * tuned for the bottom-nav touch target — distinct from the sidebar's
 * smaller multi-path glyphs in Shell.PATHS.
 */
const MOBILE_ICONS: Record<string, { d: string; match?: (p: string) => boolean }> = {
  "/":          { d: "M3 12L12 3l9 9v8a1 1 0 01-1 1h-5v-5H9v5H4a1 1 0 01-1-1v-8z", match: (p) => p === "/" },
  "/inbox":     { d: "M22 12H16l-2 3H10l-2-3H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" },
  "/approvals": { d: "M9 12l2 2 4-4M22 12a10 10 0 11-20 0 10 10 0 0120 0z" },
  "/recipes":   { d: "M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" },
  "/activity":  { d: "M22 12H18L15 21 9 3 6 12H2" },
};

const PRIMARY: BottomNavItem[] = MOBILE_PRIMARY_HREFS.map((href) => {
  const route = findRoute(href);
  const icon = MOBILE_ICONS[href];
  return {
    href,
    label: route?.label ?? href,
    d: icon?.d ?? "",
    match: icon?.match,
  };
});

const MORE_LINKS: { href: string; label: string }[] = moreRoutes().map((r) => ({
  href: r.href,
  label: r.label,
}));

const MORE_ICON = "M12 6h.01M12 12h.01M12 18h.01";

export function MobileBottomNav() {
  const pathname = usePathname() ?? "/";
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Close on route change
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  // Sheet focus trap: lock body scroll, inert the rest of the app
  // (main content, header, sidebar, bottom-nav) so Tab and screen-
  // reader navigation stay inside the sheet, close on Escape.
  // Pointer events on the bottom-nav still work, so a second tap on
  // "More" still closes the sheet — inert affects keyboard + AT only.
  useFocusTrap({
    open: sheetOpen,
    onClose: () => setSheetOpen(false),
    containerRef: sheetRef,
    inertSelector:
      "main, .app-header, .app-sidebar, .mobile-bottom-nav",
  });

  const moreActive = MORE_LINKS.some((l) => pathname.startsWith(l.href));
  // Surface halt count on the More button — the /activity route lives
  // under More on mobile, so without this the badge is invisible
  // exactly when oncall needs it.
  const haltCount = useHaltCount();

  // /login is pre-auth — no app chrome. Early return after all hooks
  // so hook order stays stable (rules-of-hooks).
  if (pathname === "/login") return null;

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
          aria-label={haltCount > 0 ? `More (${haltCount} halt${haltCount === 1 ? "" : "s"})` : "More"}
          style={{ position: "relative" }}
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
          {haltCount > 0 && (
            <span
              aria-hidden="true"
              title={`${haltCount} recent halt${haltCount === 1 ? "" : "s"}`}
              style={{
                position: "absolute",
                top: 4,
                right: "calc(50% - 16px)",
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 8,
                background: "var(--err)",
                color: "#fff",
                fontSize: "var(--fs-2xs)",
                fontWeight: 700,
                lineHeight: "16px",
                textAlign: "center",
                pointerEvents: "none",
              }}
            >
              {haltCount > 9 ? "9+" : haltCount}
            </span>
          )}
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
            ref={sheetRef}
            id="mobile-more-sheet"
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More navigation"
            tabIndex={-1}
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
