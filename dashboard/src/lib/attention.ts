/**
 * "Needs attention" band model — single source of truth for the overview
 * band's items, their order, and their severity.
 *
 * Facelift P1-7: the band previously used an `urgent: boolean` discriminant
 * whose CSS classes were backwards (`--urgent` rendered amber, `--warn`
 * rendered red) and whose band border was always amber regardless of the
 * items present. This model replaces it with an explicit severity so the
 * field name, the chip color, and the band border all agree:
 *
 *   - pending approvals → "warn" (amber): actionable, not yet a failure
 *   - failed runs / halts → "err" (red): something already went wrong
 *
 * Order is approvals → failed runs → halts (most-actionable first, then by
 * severity), and the band border takes the highest severity present.
 */

export type AttentionSeverity = "err" | "warn";

export interface AttentionItem {
  count: number;
  label: string;
  href: string;
  severity: AttentionSeverity;
}

export interface AttentionCounts {
  pendingCount: number;
  haltCount24h: number;
  failingCount24h: number;
}

export function buildAttentionItems({
  pendingCount,
  haltCount24h,
  failingCount24h,
}: AttentionCounts): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (pendingCount > 0) {
    items.push({
      count: pendingCount,
      label: pendingCount === 1 ? "approval pending" : "approvals pending",
      href: "/approvals",
      severity: "warn",
    });
  }
  if (failingCount24h > 0) {
    items.push({
      count: failingCount24h,
      label: failingCount24h === 1 ? "run failed · 24h" : "runs failed · 24h",
      href: "/runs?window=24h",
      severity: "err",
    });
  }
  if (haltCount24h > 0) {
    items.push({
      count: haltCount24h,
      label: haltCount24h === 1 ? "halt · 24h" : "halts · 24h",
      href: "/runs?halt=1",
      severity: "err",
    });
  }
  return items;
}

/** Highest severity among the items — drives the band's left-border color. */
export function bandSeverity(items: AttentionItem[]): AttentionSeverity {
  return items.some((i) => i.severity === "err") ? "err" : "warn";
}
