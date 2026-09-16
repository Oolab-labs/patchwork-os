import { createHash, timingSafeEqual } from "node:crypto";
import type { RiskTier } from "./riskTier.js";

export interface ApprovedActionFacts {
  toolName: string;
  params: Record<string, unknown>;
  sessionId?: string | null;
  tier: RiskTier;
  correlationId?: string;
  recipeName?: string;
}

export interface ApprovalGrant {
  decision: "approved";
  approvalId: string;
  approvedActionIdentity: string;
  facts: Pick<ApprovedActionFacts, "tier" | "correlationId" | "recipeName">;
}

export interface ApprovalExecutionEvidence {
  approvalId: string;
  approvedActionIdentity: string;
  approvalRevalidated: true;
}

export function executionEvidence(
  grant: ApprovalGrant,
): ApprovalExecutionEvidence {
  return {
    approvalId: grant.approvalId,
    approvedActionIdentity: grant.approvedActionIdentity,
    approvalRevalidated: true,
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

/** SHA-256 over original, pre-redaction consequential approval facts. */
export function computeApprovedActionIdentity(
  facts: ApprovedActionFacts,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        sessionId: facts.sessionId ?? "",
        toolName: facts.toolName,
        tier: facts.tier,
        correlationId: facts.correlationId ?? "",
        recipeName: facts.recipeName ?? "",
        params: facts.params,
      }),
    )
    .digest("hex");
}

export function approvalIdentityMatches(
  expected: string,
  actualFacts: ApprovedActionFacts,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = computeApprovedActionIdentity(actualFacts);
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(actual, "hex"),
  );
}
