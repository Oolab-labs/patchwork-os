import Link from "next/link";
import type { CSSProperties } from "react";

/**
 * Unified breadcrumb trail for detail pages.
 *
 * Replaces three divergent patterns found in the IA audit (2026-05-20):
 *  1. `BackLink` — a simple "← Parent" link (6 pages)
 *  2. Inline `<nav>` with `<ol>` and `/` separator in `recipes/[name]/layout.tsx`
 *  3. Ad-hoc hand-rolled links on individual pages
 *
 * `BackLink` is now a thin wrapper over this primitive (2-item breadcrumb).
 *
 * Usage:
 *   <Breadcrumb items={[{ label: "Recipes", href: "/recipes" }, { label: "my-recipe" }]} />
 *
 * The last item is treated as the current page (no href, `aria-current="page"`).
 * All other items with `href` are rendered as Next.js `<Link>` elements.
 */

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  /** Optional inline style on the wrapping `<nav>` (escape hatch only). */
  style?: CSSProperties;
}

const linkStyle: CSSProperties = {
  color: "var(--ink-3)",
  textDecoration: "none",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "18ch",
  display: "inline-block",
};

const currentStyle: CSSProperties = {
  color: "var(--ink-2)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "28ch",
  display: "inline-block",
};

const separatorStyle: CSSProperties = {
  color: "var(--ink-4, var(--ink-3))",
  userSelect: "none",
  flexShrink: 0,
};

export function Breadcrumb({ items, style }: BreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", ...style }}
    >
      <ol
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          listStyle: "none",
          padding: 0,
          margin: 0,
          flexWrap: "wrap",
        }}
      >
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          return (
            <li
              key={idx}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              {...(isLast ? { "aria-current": "page" } : {})}
            >
              {idx > 0 && (
                <span aria-hidden="true" style={separatorStyle}>
                  /
                </span>
              )}
              {isLast ? (
                <span style={currentStyle}>{item.label}</span>
              ) : item.href ? (
                <Link href={item.href} style={linkStyle}>
                  {item.label}
                </Link>
              ) : (
                <span style={linkStyle}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
