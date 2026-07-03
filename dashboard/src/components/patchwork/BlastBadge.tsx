"use client";

import { DOMAIN_PLAIN_NAME, type ClientActionClass } from "@/lib/actionClass";

/**
 * Badge copy + tone for a resolved action class, or the unclassified
 * fallback. Never fabricates a tier for an unknown tool.
 *
 * Extracted from the approvals "Considered" redesign (app/approvals/page.tsx)
 * so /today can reuse the identical blast-radius language instead of
 * re-deriving its own copy for the same classifier.
 */
export function blastBadge(cls: ClientActionClass | null): {
  label: string;
  icon: string;
  tone: "err" | "warn" | "ok" | "muted";
} {
  if (!cls) return { label: "unclassified", icon: "?", tone: "muted" };
  if (cls.reversibility === "irreversible") {
    return { label: "irreversible", icon: "⛔", tone: "err" };
  }
  if (cls.reversibility === "compensable") {
    return { label: "compensable", icon: "↩", tone: "warn" };
  }
  return { label: "reversible", icon: "✓", tone: "ok" };
}

export function BlastBadge({ cls }: { cls: ClientActionClass | null }) {
  const b = blastBadge(cls);
  const title = cls
    ? `${DOMAIN_PLAIN_NAME[cls.domain] ?? cls.domain} · ${b.label}`
    : "Could not resolve an action class for this tool — sort/gate treat it like a reversible action, but this is a genuine unknown, not a claim of safety.";
  return (
    <span className={`pill ${b.tone} apc-blast-badge`} title={title}>
      <span aria-hidden="true">{b.icon}</span> {b.label}
    </span>
  );
}
