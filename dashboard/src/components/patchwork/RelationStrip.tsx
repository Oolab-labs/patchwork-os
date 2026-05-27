import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Compact horizontal chip strip that surfaces "what this entity
 * touches" below a detail-page H1. Each chip is a Link to a related
 * page — the user can fan out from any detail to its neighbours
 * without going back to a list view.
 *
 * Example placement (recipe detail):
 *
 *   <h1>morning-pulse</h1>
 *   <RelationStrip items={[
 *     { label: "12 runs",   href: "/runs?recipe=morning-pulse" },
 *     { label: "3 halts",   href: "/runs?recipe=morning-pulse&halt=1", tone: "warn" },
 *     { label: "Gmail",     href: "/connections" },
 *     { label: "Slack",     href: "/connections" },
 *   ]}/>
 *
 * Before this primitive, every detail page was an island — pages
 * showed their own data but not which other pages held related data.
 * The IA audit (2026-05-12) identified that disconnection as the
 * second biggest "disjointed" driver after orphan routes.
 */

export type RelationTone = "neutral" | "accent" | "warn" | "err" | "ok";

export interface RelationItem {
  /** Visible text on the chip. */
  label: string;
  /** Where the chip links to. External-url-safe (will use `target="_blank"`). */
  href: string;
  /** Optional leading icon / emoji. Keep tiny — chip is 22px tall. */
  icon?: ReactNode;
  /** Tints the chip border + text. Defaults to "neutral". */
  tone?: RelationTone;
  /** Hover tooltip (defaults to the href). */
  title?: string;
}

export interface RelationStripProps {
  items: RelationItem[];
  /** Optional aria-label for the wrapping nav. Defaults to "Related". */
  label?: string;
  /** Extra inline margin (the strip sits below an H1; usually 4–8 px). */
  marginTop?: number;
}

function toneStyles(tone: RelationTone = "neutral"): {
  borderColor: string;
  color: string;
  background: string;
} {
  switch (tone) {
    case "accent":
      return {
        borderColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 8%, transparent)",
      };
    case "warn":
      return {
        borderColor: "color-mix(in srgb, var(--amber) 35%, transparent)",
        color: "var(--amber)",
        background: "color-mix(in srgb, var(--amber) 8%, transparent)",
      };
    case "err":
      return {
        borderColor: "color-mix(in srgb, var(--red) 35%, transparent)",
        color: "var(--red)",
        background: "color-mix(in srgb, var(--red) 8%, transparent)",
      };
    case "ok":
      return {
        borderColor: "color-mix(in srgb, var(--green) 35%, transparent)",
        color: "var(--green)",
        background: "color-mix(in srgb, var(--green) 8%, transparent)",
      };
    default:
      return {
        borderColor: "var(--line-2)",
        color: "var(--ink-2)",
        background: "transparent",
      };
  }
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function RelationStrip({
  items,
  label = "Related",
  marginTop = 6,
}: RelationStripProps) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={label}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        marginTop,
        fontSize: "var(--fs-xs)",
      }}
    >
      {items.map((it, i) => {
        const styles = toneStyles(it.tone);
        const chipStyle = {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 9px",
          minHeight: "32px",
          borderRadius: 999,
          border: `1px solid ${styles.borderColor}`,
          background: styles.background,
          color: styles.color,
          textDecoration: "none",
          lineHeight: 1.4,
          transition: "border-color 120ms, background 120ms",
        } as const;
        const tooltip = it.title ?? it.href;
        const content = (
          <>
            {it.icon !== undefined && (
              <span aria-hidden="true" style={{ display: "inline-flex" }}>
                {it.icon}
              </span>
            )}
            <span>{it.label}</span>
          </>
        );
        return isExternal(it.href) ? (
          <a
            // eslint-disable-next-line react/jsx-no-target-blank -- intentional, noopener noreferrer included
            key={`${it.href}-${i}`}
            href={it.href}
            title={tooltip}
            target="_blank"
            rel="noopener noreferrer"
            style={chipStyle}
          >
            {content}
          </a>
        ) : (
          <Link key={`${it.href}-${i}`} href={it.href} title={tooltip} style={chipStyle}>
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
