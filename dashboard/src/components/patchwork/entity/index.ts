/**
 * Shared entity-component layer (Phase 0γ).
 *
 * Chips own identity + link + label; pills (StatusPill / RiskPill /
 * LivePill) own status tone. Every chip in here renders a real link
 * so keyboard-nav + middle-click come free at the call site.
 *
 * Page adoption (replacing hand-rolled chips on existing pages) is
 * Phase 2 and lives in a separate PR — this barrel is purely additive.
 */

export { RunChip, type RunChipProps, type RunStatus } from "./RunChip";
export { RecipeChip, type RecipeChipProps } from "./RecipeChip";
export { ToolChip, type ToolChipProps } from "./ToolChip";
export { SessionChip, type SessionChipProps } from "./SessionChip";
export {
  ApprovalChip,
  type ApprovalChipProps,
  type ApprovalDecision,
} from "./ApprovalChip";
export { TraceChip, type TraceChipProps } from "./TraceChip";
export { ConnectorChip, type ConnectorChipProps } from "./ConnectorChip";
export { InboxChip, type InboxChipProps } from "./InboxChip";
export {
  EntityLink,
  useEntityHref,
  type EntityLinkProps,
} from "./EntityLink";
export { type EntityKind, type EntityVariant } from "./types";
