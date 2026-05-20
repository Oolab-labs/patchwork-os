import Link from "next/link";
import {
  StatusPill,
  type StatusTone,
} from "@/components/patchwork/StatusPill";
import { type EntityVariant, variantStyle } from "./types";

export type ApprovalDecision = "pending" | "approved" | "rejected";

export interface ApprovalChipProps {
  callId: string;
  tier?: string;
  decision?: ApprovalDecision;
  variant?: EntityVariant;
}

const DECISION_TONE: Record<ApprovalDecision, StatusTone> = {
  pending: "warn",
  approved: "ok",
  rejected: "err",
};

/**
 * <ApprovalChip> — linked identity chip for a single approval call.
 *
 * Labels with the tier (if known) and the decision verdict; status tone
 * comes from a StatusPill so colour is never the sole signal.
 */
export function ApprovalChip({
  callId,
  tier,
  decision,
  variant = "chip",
}: ApprovalChipProps) {
  const { className, style } = variantStyle(variant);
  const label = tier ? tier : callId.slice(0, 10);
  const ariaLabel = `Approval ${callId}${tier ? ` (${tier})` : ""}${
    decision ? `, ${decision}` : ""
  }`;
  return (
    <Link
      href={`/approvals/${callId}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span style={{ fontFamily: "var(--font-mono)" }}>{label}</span>
      {decision && (
        <StatusPill tone={DECISION_TONE[decision]} srLabel={decision}>
          {decision}
        </StatusPill>
      )}
    </Link>
  );
}
