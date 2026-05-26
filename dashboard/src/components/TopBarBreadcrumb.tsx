"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { flatRoutes } from "@/lib/navRoutes";

interface BreadcrumbSegment {
  label: string;
  href?: string;
  last: boolean;
}

function buildBreadcrumbs(pathname: string): BreadcrumbSegment[] {
  if (!pathname || pathname === "/") return [];

  const routes = flatRoutes();
  const routeMap = new Map(routes.map((r) => [r.href, r.label]));

  const segments = pathname.split("/").filter(Boolean);
  const crumbs: BreadcrumbSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const href = "/" + segments.slice(0, i + 1).join("/");
    const isLast = i === segments.length - 1;

    const routeLabel = routeMap.get(href);
    if (routeLabel) {
      crumbs.push({ label: routeLabel, href: isLast ? undefined : href, last: isLast });
      continue;
    }

    // Dynamic segment heuristics
    if (i > 0) {
      const parentHref = "/" + segments.slice(0, i).join("/");
      const _parentLabel = routeMap.get(parentHref);

      // /runs/:seq → "Runs › #seq"
      if (parentHref === "/runs" && /^\d+$/.test(seg)) {
        crumbs.push({ label: `#${seg}`, last: isLast });
        continue;
      }
      // /sessions/:id → "Sessions › ab12cd34"
      if (parentHref === "/sessions") {
        crumbs.push({ label: seg.slice(0, 8), last: isLast });
        continue;
      }
      // /recipes/:name/… — recipe name then sub-pages
      if (parentHref === "/recipes") {
        crumbs.push({ label: seg, href: isLast ? undefined : href, last: isLast });
        continue;
      }
      // Sub-pages of known routes: /recipes/:name/edit → "Edit"
      const titleCase = seg.charAt(0).toUpperCase() + seg.slice(1);
      crumbs.push({ label: titleCase, last: isLast });
    }
  }

  return crumbs;
}

export function TopBarBreadcrumb() {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs(pathname ?? "");

  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: "var(--fs-m)",
        maxWidth: 320,
        overflow: "hidden",
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      {crumbs.map((crumb, i) => (
        <span key={crumb.href ?? crumb.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {i > 0 && (
            <span style={{ color: "var(--ink-3)", fontWeight: 400, flexShrink: 0 }}>›</span>
          )}
          {crumb.href ? (
            <Link
              href={crumb.href}
              style={{
                color: "var(--ink-2)",
                fontWeight: 500,
                textDecoration: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {crumb.label}
            </Link>
          ) : (
            <span
              style={{
                color: crumb.last ? "var(--ink-1)" : "var(--ink-2)",
                fontWeight: crumb.last ? 600 : 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
