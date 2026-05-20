import Link from "next/link";
import { EmptyState } from "./EmptyState";
import {
  RunChip,
  RecipeChip,
  InboxChip,
  ApprovalChip,
  TraceChip,
  SessionChip,
  ConnectorChip,
} from "./entity";

/**
 * The kind discriminator drives which entity chip is rendered in the
 * panel. Each value maps to a chip in the @/components/patchwork/entity
 * barrel — keep this in sync with EntityKind in entity/types.ts.
 */
export type RelatedItemKind =
  | "run"
  | "recipe"
  | "inbox"
  | "approval"
  | "trace"
  | "session"
  | "connector";

export interface RelatedItem {
  kind: RelatedItemKind;
  /** Entity identity key — passed to the matching chip as `id` or `seq` etc. */
  id: string;
  /** Human-readable label for the item. Used as fallback when the chip
   *  alone doesn't carry enough context (e.g. trace keys). */
  label: string;
  /** Optional link override. When only href is available (no chip match),
   *  the panel renders a <Link> instead. */
  href?: string;
  /** Muted secondary text shown below/next to the chip — timestamps,
   *  status, duration, etc. */
  meta?: string;
}

export interface RelatedGroup {
  label: string;
  items: RelatedItem[];
}

export interface RelatedPanelProps {
  /** Section title rendered at the top of the rail. */
  title?: string;
  groups: RelatedGroup[];
}

/**
 * `RelatedPanel` — persistent vertical side rail.
 *
 * Shows related entities grouped by category so the user can hop to a
 * neighbour without bouncing through list pages.  Intentionally
 * separate from `RelationStrip` (the quick horizontal top strip):
 *
 * - `RelationStrip` = compact top-of-page hop strip (counts / types)
 * - `RelatedPanel`  = richer sidebar with grouped lists + chip identity
 *
 * Empty groups are omitted. If every group is empty the panel renders
 * nothing at all (no empty shell in the layout).
 *
 * Responsive: on narrow viewports the panel stacks below the main
 * content rather than floating beside it. Use a parent grid/flex wrapper
 * to place it — the panel itself sets `minWidth: 0` and `width: 100%`
 * so it adapts.
 */

function ItemChip({ item }: { item: RelatedItem }) {
  switch (item.kind) {
    case "run": {
      const seq = Number(item.id);
      if (!Number.isNaN(seq)) {
        return <RunChip seq={seq} variant="chip" />;
      }
      break;
    }
    case "recipe":
      return <RecipeChip name={item.id} variant="chip" />;
    case "inbox":
      return <InboxChip name={item.id} variant="chip" />;
    case "approval":
      return <ApprovalChip callId={item.id} variant="chip" />;
    case "trace":
      return <TraceChip traceKey={item.id} traceType="decision" variant="chip" />;
    case "session":
      return <SessionChip id={item.id} variant="chip" />;
    case "connector":
      return <ConnectorChip id={item.id} variant="chip" />;
  }
  // Fallback: href link or plain label
  if (item.href) {
    return (
      <Link
        href={item.href}
        style={{
          fontSize: "var(--fs-xs)",
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        {item.label}
      </Link>
    );
  }
  return (
    <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-2)" }}>
      {item.label}
    </span>
  );
}

export function RelatedPanel({ title = "Related", groups }: RelatedPanelProps) {
  const activeGroups = groups.filter((g) => g.items.length > 0);

  if (activeGroups.length === 0) {
    return (
      <EmptyState
        title="Nothing related yet"
        description="Related entities will appear here as the recipe runs."
      />
    );
  }

  return (
    <nav
      aria-label="Related"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-4, 16px)",
        width: "100%",
        minWidth: 0,
      }}
    >
      {/* Panel title */}
      <div
        style={{
          fontSize: "var(--fs-xs)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-3)",
        }}
      >
        {title}
      </div>

      {activeGroups.map((group) => (
        <section
          key={group.label}
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-2, 6px)" }}
        >
          {/* Group label */}
          <div
            style={{
              fontSize: "var(--fs-2xs)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--ink-3)",
            }}
          >
            {group.label}
          </div>

          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-2, 6px)",
            }}
          >
            {group.items.map((item, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey -- stable list, no reordering
              <li
                key={`${item.kind}-${item.id}-${idx}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    minWidth: 0,
                  }}
                >
                  <ItemChip item={item} />
                </div>
                {item.meta && (
                  <span
                    style={{
                      fontSize: "var(--fs-2xs)",
                      color: "var(--ink-3)",
                      paddingLeft: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={item.meta}
                  >
                    {item.meta}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
