import type { TrustMetadata } from "@/lib/registry";

/**
 * Trust-vs-YAML reconciliation for the recipe DETAIL page.
 *
 * GROUP S3 (marketplace investigation 2026-06-04): the detail page renders
 * the registry trust metadata (TrustMetadataCard, sourced from index.json)
 * and a YAML-derived risk summary (summarizeRisk over the actual recipe YAML)
 * adjacently with NO reconciliation. A green "low risk" / "no file access"
 * pill could sit beside high-risk YAML steps and nothing warned the user —
 * a stale OR tampered registry index could mask what the recipe actually does.
 *
 * The metadata is self-reported (and the registry is community-maintained,
 * not signature-verified). The YAML is the ground truth that will run. When
 * they disagree, surface it: prefer the more dangerous of the two signals and
 * tell the user exactly which claim the YAML contradicts.
 *
 * The detection helper lives here (not in registry.ts, which is locked by an
 * open PR) so it is independently unit-testable.
 */

/** The metadata fields this reconciliation inspects (subset of TrustMetadata). */
export type DivergenceMeta = Pick<
  TrustMetadata,
  "risk_level" | "network_access" | "file_access"
>;

/** Shape returned by `summarizeRisk(yaml)` in @/lib/registry. */
export interface RiskSummary {
  low: number;
  medium: number;
  high: number;
  steps: number;
}

/**
 * Return the list of contradictions between the registry trust metadata and
 * the YAML-derived risk summary. Empty list ⇒ no divergence (render nothing).
 *
 * Pure + dependency-free so it can be unit-tested in isolation.
 */
export function detectTrustDivergence(
  meta: DivergenceMeta,
  riskSummary: RiskSummary,
): string[] {
  const contradictions: string[] = [];

  // No steps parsed from the YAML ⇒ nothing to reconcile against. The risk
  // summary returns all-zeros on parse failure too, so this also avoids
  // false positives when the YAML couldn't be fetched / parsed.
  if (riskSummary.steps === 0) return contradictions;

  const hasMedium = riskSummary.medium > 0;
  const hasHigh = riskSummary.high > 0;
  const hasElevated = hasMedium || hasHigh;

  // 1. risk_level claims "low" but the YAML declares medium/high-risk steps.
  if (meta.risk_level === "low" && hasElevated) {
    const parts: string[] = [];
    if (hasHigh) parts.push(`${riskSummary.high} high-risk`);
    if (hasMedium) parts.push(`${riskSummary.medium} medium-risk`);
    contradictions.push(
      `Listed as low risk, but the recipe YAML declares ${parts.join(
        " and ",
      )} step${riskSummary.high + riskSummary.medium === 1 ? "" : "s"}.`,
    );
  }

  // High-risk YAML steps are the strongest signal that the recipe does more
  // than its metadata claims — they typically write files and/or make network
  // calls. When the metadata explicitly opts OUT of those capabilities, flag it.
  if (hasHigh) {
    // 2. file_access:false but high-risk steps present.
    if (meta.file_access === false) {
      contradictions.push(
        `Declares no file access, but the recipe YAML contains ${riskSummary.high} high-risk step${riskSummary.high === 1 ? "" : "s"} that may read or write local files.`,
      );
    }
    // 3. network_access:false but high-risk steps present.
    if (meta.network_access === false) {
      contradictions.push(
        `Declares no network access, but the recipe YAML contains ${riskSummary.high} high-risk step${riskSummary.high === 1 ? "" : "s"} that may make outbound requests.`,
      );
    }
  }

  return contradictions;
}

/**
 * Inline warning rendered between the trust card and the install panel.
 * Renders nothing when the metadata and YAML are consistent.
 */
export function TrustDivergenceNotice({
  meta,
  riskSummary,
}: {
  meta: DivergenceMeta;
  riskSummary: RiskSummary;
}) {
  const contradictions = detectTrustDivergence(meta, riskSummary);
  if (contradictions.length === 0) return null;

  return (
    <div
      role="alert"
      className="glass-card"
      style={{
        padding: "var(--s-4) var(--s-5)",
        background: "var(--err-soft, var(--warn-soft))",
        border: "1px solid var(--err, var(--warn))",
        fontSize: "var(--fs-s)",
        color: "var(--ink-1)",
        lineHeight: 1.6,
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
      }}
    >
      <strong style={{ color: "var(--ink-0)" }}>
        Trust metadata doesn&apos;t match the recipe YAML
      </strong>
      <p style={{ margin: 0, color: "var(--ink-2)" }}>
        The self-reported trust labels below disagree with what the recipe
        source actually declares. Trust the YAML — review it before installing.
      </p>
      <ul
        style={{
          margin: 0,
          paddingLeft: "1.2em",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-1)",
        }}
      >
        {contradictions.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}
