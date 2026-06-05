/**
 * TrustDivergenceNotice — reconciles registry index.json trust metadata
 * against the YAML-derived risk summary so a green "low risk" pill can't
 * silently sit next to high-risk YAML steps.
 *
 * GROUP S3 (marketplace investigation 2026-06-04): the detail page rendered
 * the TrustMetadataCard (from index.json) and the "Steps & risk" summary
 * (from the actual recipe YAML) adjacently with NO reconciliation. A tampered
 * or stale registry index claiming low/no-access could mask a recipe whose
 * YAML clearly writes files / hits the network / runs high-risk steps.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  detectTrustDivergence,
  TrustDivergenceNotice,
} from "../TrustDivergenceNotice";

// Mirror the real shapes the detail page already computes:
//   - meta: subset of RegistryRecipe (index.json trust metadata)
//   - riskSummary: return shape of summarizeRisk(yaml)
const emptyRisk = { low: 0, medium: 0, high: 0, steps: 0 };

describe("detectTrustDivergence", () => {
  it("flags low-risk metadata when YAML has high-risk steps", () => {
    const out = detectTrustDivergence(
      { risk_level: "low" },
      { low: 1, medium: 0, high: 2, steps: 3 },
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags low-risk metadata when YAML has medium-risk steps", () => {
    const out = detectTrustDivergence(
      { risk_level: "low" },
      { low: 0, medium: 1, high: 0, steps: 1 },
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags file_access:false when YAML has high-risk steps (likely file writes)", () => {
    const out = detectTrustDivergence(
      { file_access: false },
      { low: 0, medium: 0, high: 1, steps: 1 },
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags network_access:false when YAML has high-risk steps (likely network)", () => {
    const out = detectTrustDivergence(
      { network_access: false },
      { low: 0, medium: 0, high: 1, steps: 1 },
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns empty for fully-consistent inputs (low meta + only low steps)", () => {
    const out = detectTrustDivergence(
      { risk_level: "low", network_access: false, file_access: false },
      { low: 3, medium: 0, high: 0, steps: 3 },
    );
    expect(out).toEqual([]);
  });

  it("returns empty when metadata matches elevated YAML risk", () => {
    const out = detectTrustDivergence(
      { risk_level: "high", network_access: true, file_access: true },
      { low: 0, medium: 1, high: 2, steps: 3 },
    );
    expect(out).toEqual([]);
  });

  it("returns empty when there are no steps to reconcile against", () => {
    const out = detectTrustDivergence({ risk_level: "low" }, emptyRisk);
    expect(out).toEqual([]);
  });

  it("returns empty when metadata is absent (nothing to contradict)", () => {
    const out = detectTrustDivergence({}, { low: 0, medium: 1, high: 1, steps: 2 });
    expect(out).toEqual([]);
  });
});

describe("TrustDivergenceNotice (render)", () => {
  it("renders an alert when metadata diverges from YAML risk", () => {
    render(
      <TrustDivergenceNotice
        meta={{ risk_level: "low" }}
        riskSummary={{ low: 0, medium: 0, high: 2, steps: 2 }}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders nothing when inputs are consistent", () => {
    const { container } = render(
      <TrustDivergenceNotice
        meta={{ risk_level: "low", network_access: false, file_access: false }}
        riskSummary={{ low: 2, medium: 0, high: 0, steps: 2 }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
