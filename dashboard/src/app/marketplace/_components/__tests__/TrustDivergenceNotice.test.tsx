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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryRecipe } from "@/lib/registry";
import {
  checkTrustDivergence,
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

// Regression: the marketplace BROWSE grid (dashboard/src/app/marketplace/
// page.tsx's useRecipeInstall) gates its one-click-vs-confirm-dialog
// decision on registry metadata alone — the same class of bug #1185 fixed
// on the detail page's InstallPanel. checkTrustDivergence is the fetch +
// reconcile helper the browse grid calls at install-click time (not eagerly
// per card) to close that gap; test it directly against a mocked fetch
// rather than mounting the 1000+-line, untested page component.
describe("checkTrustDivergence", () => {
  const baseRecipe: RegistryRecipe = {
    name: "@patchworkos/example",
    version: "1.0.0",
    description: "example",
    tags: [],
    connectors: [],
    downloads: 0,
    install: "github:patchworkos/recipes/recipes/example",
  };

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function textResponse(body: string): Response {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when metadata claims low-risk but the YAML declares high-risk steps", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ name: "example", version: "1.0.0", recipes: { main: "recipe.yaml" } }),
      )
      .mockResolvedValueOnce(
        textResponse("steps:\n  - risk: high\n  - risk: high\n"),
      );

    const divergent = await checkTrustDivergence({
      ...baseRecipe,
      risk_level: "low",
      network_access: false,
      file_access: false,
    });
    expect(divergent).toBe(true);
  });

  it("returns false when metadata and YAML agree", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ name: "example", version: "1.0.0", recipes: { main: "recipe.yaml" } }),
      )
      .mockResolvedValueOnce(textResponse("steps:\n  - risk: low\n"));

    const divergent = await checkTrustDivergence({
      ...baseRecipe,
      risk_level: "low",
      network_access: false,
      file_access: false,
    });
    expect(divergent).toBe(false);
  });

  it("fails open (returns false) when the manifest fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network error"));

    const divergent = await checkTrustDivergence({
      ...baseRecipe,
      risk_level: "low",
      network_access: false,
      file_access: false,
    });
    expect(divergent).toBe(false);
  });

  it("returns false for an unparseable install source", async () => {
    const divergent = await checkTrustDivergence({
      ...baseRecipe,
      install: "not-a-github-source",
      risk_level: "low",
    });
    expect(divergent).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
