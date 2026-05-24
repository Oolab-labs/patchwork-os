import Link from "next/link";
import { EmptyState } from "./EmptyState";
import { RunChip } from "./entity/RunChip";
import { InboxChip } from "./entity/InboxChip";
import { ApprovalChip, type ApprovalDecision } from "./entity/ApprovalChip";
import { TraceChip } from "./entity/TraceChip";

/**
 * Discriminated event in an entity timeline.
 *
 * `kind` drives which entity chip (if any) to render alongside the label.
 * Keep `id` on event-level data — the chips use it when present.
 */
export interface TimelineEvent {
  /** Stable key for React. */
  id: string;
  kind: "run" | "inbox" | "approval" | "trace" | "step" | "trigger";
  /** Unix ms timestamp — timeline is sorted newest-first. */
  timestamp: number;
  /** Human-readable description of this event. */
  label: string;
  /** Optional navigation target (used for plain links on step / trigger rows). */
  href?: string;
  /** Optional status string passed through to RunChip and shown as a badge. */
  status?: string;
  /**
   * Entity-specific context bag.
   *
   * run       → { seq: number; recipeName?: string; hadStepErrors?: boolean }
   * inbox     → { name: string; recipeName?: string }
   * approval  → { callId: string; decision?: string }
   * trace     → { traceKey: string; traceType?: string }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: Record<string, unknown>;
}

// ------------------------------------------------------------------ helpers

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Map each kind to a small colour dot on the spine. */
function kindDotColor(kind: TimelineEvent["kind"]): string {
  switch (kind) {
    case "run":      return "var(--blue, #4a90d9)";
    case "inbox":    return "var(--green, #4caf50)";
    case "approval": return "var(--amber, #d49a3a)";
    case "trace":    return "var(--accent, #7c6ff7)";
    case "step":     return "var(--ink-3, #9ca3af)";
    case "trigger":  return "var(--ink-2, #6b7280)";
    default:         return "var(--line-2)";
  }
}

/** Render the entity chip for a row, or null when the kind has no chip. */
function EntityChip({ event }: { event: TimelineEvent }) {
  const { kind, meta = {} } = event;

  if (kind === "run" && typeof meta.seq === "number") {
    return (
      <RunChip
        seq={meta.seq as number}
        status={event.status}
        hadStepErrors={meta.hadStepErrors as boolean | undefined}
        recipeName={meta.recipeName as string | undefined}
        variant="chip"
      />
    );
  }

  if (kind === "inbox" && typeof meta.name === "string") {
    return (
      <InboxChip
        name={meta.name as string}
        recipeName={meta.recipeName as string | undefined}
        variant="chip"
      />
    );
  }

  if (kind === "approval" && typeof meta.callId === "string") {
    const approvalDecisions: ApprovalDecision[] = ["pending", "approved", "rejected"];
    const rawDecision = meta.decision as string | undefined;
    const decision = rawDecision && approvalDecisions.includes(rawDecision as ApprovalDecision)
      ? rawDecision as ApprovalDecision
      : undefined;
    return (
      <ApprovalChip
        callId={meta.callId as string}
        decision={decision}
        variant="chip"
      />
    );
  }

  if (kind === "trace" && typeof meta.traceKey === "string") {
    return (
      <TraceChip
        traceKey={meta.traceKey as string}
        traceType={(meta.traceType as string | undefined) ?? "decision"}
        variant="chip"
      />
    );
  }

  // step / trigger with href → plain Link
  if (event.href) {
    return (
      <Link
        href={event.href}
        style={{
          fontSize: "var(--fs-xs)",
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        {event.label}
      </Link>
    );
  }

  return null;
}

// ------------------------------------------------------------------ component

export interface EntityTimelineProps {
  events: TimelineEvent[];
  /** Accessible label for the wrapping <ol>. Defaults to "Timeline". */
  ariaLabel?: string;
}

/**
 * EntityTimeline — vertical chronological (newest-first) event list.
 *
 * Presentational only: pass pre-shaped TimelineEvent[]; no fetching inside.
 * Accessible: the list is an <ol> with <li> rows; the spine is aria-hidden.
 */
export function EntityTimeline({
  events,
  ariaLabel = "Timeline",
}: EntityTimelineProps) {
  if (events.length === 0) {
    return <EmptyState title="No timeline events" description="Events will appear here as this entity accumulates activity." />;
  }

  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  const isLast = (i: number) => i === sorted.length - 1;

  return (
    <ol
      aria-label={ariaLabel}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {sorted.map((event, i) => {
        const dotColor = kindDotColor(event.kind);
        // Call as a function so we can check for null synchronously.
        // Using JSX here would always produce a React element (never null).
        const chip = EntityChip({ event });

        return (
          <li
            key={event.id}
            style={{
              display: "grid",
              gridTemplateColumns: "24px 1fr",
              gap: "0 10px",
              position: "relative",
            }}
          >
            {/* ── spine ── */}
            <div
              aria-hidden="true"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              {/* dot */}
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: dotColor,
                  flexShrink: 0,
                  marginTop: 5,
                  zIndex: 1,
                }}
              />
              {/* connector line to next item */}
              {!isLast(i) && (
                <div
                  style={{
                    flex: 1,
                    width: 1,
                    background: `linear-gradient(to bottom, ${dotColor} 0%, var(--line-3) 60%, transparent 100%)`,
                    minHeight: 16,
                    marginTop: 2,
                    opacity: 0.7,
                  }}
                />
              )}
            </div>

            {/* ── row body ── */}
            <div
              style={{
                paddingBottom: isLast(i) ? 0 : 16,
                minWidth: 0,
              }}
            >
              {/* kind badge + time */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: chip ? 4 : 0,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--fs-2xs)",
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {event.kind}
                </span>
                <span
                  style={{
                    fontSize: "var(--fs-2xs)",
                    color: "var(--ink-3)",
                  }}
                >
                  {relTime(event.timestamp)}
                </span>
              </div>

              {/* chip or label */}
              {chip ? (
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {chip}
                  {/* Only show label separately when chip doesn't already encode it (step/trigger chips render the label themselves) */}
                  {event.kind !== "step" && event.kind !== "trigger" && event.href == null && (
                    <span
                      style={{
                        fontSize: "var(--fs-s)",
                        color: "var(--ink-1)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "100%",
                      }}
                    >
                      {event.label}
                    </span>
                  )}
                </div>
              ) : (
                <span
                  style={{
                    fontSize: "var(--fs-s)",
                    color: "var(--ink-2)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "block",
                    maxWidth: "100%",
                  }}
                >
                  {event.label}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
