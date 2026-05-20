import Link from "next/link";
import { canonicalRecipeKey, inboxItemKey } from "@/lib/entityKey";
import { ApprovalChip } from "./ApprovalChip";
import { ConnectorChip } from "./ConnectorChip";
import { InboxChip } from "./InboxChip";
import { RecipeChip } from "./RecipeChip";
import { RunChip } from "./RunChip";
import { SessionChip } from "./SessionChip";
import { ToolChip } from "./ToolChip";
import { TraceChip } from "./TraceChip";
import { type EntityKind, type EntityVariant, variantStyle } from "./types";

export interface EntityLinkProps {
  kind: EntityKind;
  id: string;
  label?: string;
  variant?: EntityVariant;
}

/**
 * <EntityLink> — kind-dispatched chip.
 *
 * Lets callers render any entity by `(kind, id)` without importing the
 * specific chip. The visual / link contract matches the kind-specific
 * chip exactly. `task` and `decision` are minimal-chip variants that
 * the dedicated chips don't (yet) cover — they share the same generic
 * shape.
 */
export function EntityLink({
  kind,
  id,
  label,
  variant = "chip",
}: EntityLinkProps) {
  switch (kind) {
    case "run": {
      const seq = Number.parseInt(id, 10);
      return <RunChip seq={Number.isFinite(seq) ? seq : 0} variant={variant} />;
    }
    case "recipe":
      return <RecipeChip name={id} variant={variant} />;
    case "tool":
      return <ToolChip name={id} variant={variant} />;
    case "session":
      return <SessionChip id={id} variant={variant} />;
    case "approval":
      return <ApprovalChip callId={id} variant={variant} />;
    case "trace":
      return (
        <TraceChip
          traceKey={id}
          traceType={label ?? "decision"}
          variant={variant}
        />
      );
    case "connector":
      return <ConnectorChip id={id} variant={variant} />;
    case "inbox":
      return <InboxChip name={id} variant={variant} />;
    case "task":
      return <GenericChip kind="task" id={id} label={label} variant={variant} />;
    case "decision":
      return (
        <GenericChip kind="decision" id={id} label={label} variant={variant} />
      );
  }
}

/**
 * Hook returning the canonical href for an entity (kind, id).
 *
 * Exposed so `RelationStrip` items can later be built from the same
 * resolver — keeps URLs in lockstep with the chips.
 */
export function useEntityHref(kind: EntityKind, id: string): string {
  switch (kind) {
    case "run":
      return `/runs/${id}`;
    case "recipe":
      return `/recipes/${canonicalRecipeKey(id)}`;
    case "tool":
      return `/insights?tool=${encodeURIComponent(id)}`;
    case "session":
      return `/sessions/${encodeURIComponent(id)}`;
    case "approval":
      return `/approvals/${id}`;
    case "trace":
      return `/traces?q=${encodeURIComponent(id)}`;
    case "connector":
      return `/connections#${id}`;
    case "inbox":
      return `/inbox?item=${encodeURIComponent(inboxItemKey(id))}`;
    case "task":
      return `/tasks?id=${encodeURIComponent(id)}`;
    case "decision":
      return `/decisions?ref=${encodeURIComponent(id)}`;
  }
}

function GenericChip({
  kind,
  id,
  label,
  variant = "chip",
}: {
  kind: "task" | "decision";
  id: string;
  label?: string;
  variant?: EntityVariant;
}) {
  const { className, style } = variantStyle(variant);
  const href = useEntityHref(kind, id);
  const text = label ?? id;
  const kindLabel = kind === "task" ? "Task" : "Decision";
  const ariaLabel = `${kindLabel} ${text}`;
  return (
    <Link
      href={href}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span style={{ fontFamily: "var(--font-mono)" }}>{text}</span>
    </Link>
  );
}
