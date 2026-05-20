/**
 * Shared types + helpers for the entity-chip family.
 *
 * Chips own identity + link + label; pills (StatusPill / RiskPill /
 * LivePill) own status tone. These types are the small contract the
 * whole family shares — `EntityVariant` is the visual register and
 * `EntityKind` is the dispatcher's discriminator.
 */

import type { CSSProperties } from "react";

export type EntityVariant = "chip" | "row" | "link";

export type EntityKind =
  | "run"
  | "recipe"
  | "tool"
  | "session"
  | "approval"
  | "trace"
  | "connector"
  | "inbox"
  | "task"
  | "decision";

/** Inline style + className applied based on the requested variant. */
export function variantStyle(variant: EntityVariant = "chip"): {
  className: string;
  style: CSSProperties;
} {
  if (variant === "link") {
    return {
      className: "entity-link entity-link--link",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        textDecoration: "underline",
        color: "inherit",
      },
    };
  }
  if (variant === "row") {
    return {
      className: "entity-link entity-link--row",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        textDecoration: "none",
        color: "inherit",
      },
    };
  }
  // "chip" — default
  return {
    className: "entity-link entity-link--chip",
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
      background: "color-mix(in srgb, currentColor 6%, transparent)",
      textDecoration: "none",
      color: "inherit",
      fontSize: "var(--fs-xs)",
      lineHeight: 1.2,
    },
  };
}
