/**
 * The Data boundary page must not conflate absence with failure, crash on a
 * partial body, or describe coverage the runtime no longer has (audit M31).
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let hookValue: Record<string, unknown> = {};
vi.mock("@/hooks/useBridgeFetch", () => ({
  useBridgeFetch: () => hookValue,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/privacy",
}));

import PrivacyPage from "../page";

afterEach(() => {
  hookValue = {};
});

const base = { error: null, loading: false, refetch: vi.fn(), unsupported: false };

describe("Data boundary page states", () => {
  it("an older bridge that does not serve the ledger says so, not a blank page", () => {
    hookValue = { ...base, data: null, unsupported: true };
    render(<PrivacyPage />);
    expect(screen.getByText(/does not serve/i)).toBeTruthy();
  });

  it("a partial body renders instead of crashing", () => {
    hookValue = { ...base, data: { recorded: 3, refusals: 0 } };
    expect(() => render(<PrivacyPage />)).not.toThrow();
    expect(screen.getAllByText(/3/).length).toBeGreaterThan(0);
  });

  it("coverage copy describes the orchestrator opt-in, and receipts name their label source", () => {
    hookValue = {
      ...base,
      data: {
        recorded: 1,
        refusals: 0,
        byDecision: { ALLOW: 1 },
        byDestination: { "local-models": 1 },
        byClassification: { internal: 1 },
        refusalsByRecipe: {},
        refusalsUnattributed: 0,
        unreadableLines: 0,
        truncated: false,
        recent: [
          {
            at: Date.now(),
            decision: "ALLOW",
            classification: "internal",
            destinationId: "local-models",
            reason: "cleared",
            labelSource: "assumed",
          },
        ],
      },
    };
    render(<PrivacyPage />);
    expect(screen.getByText(/privacy\.orchestrator\.classification/)).toBeTruthy();
    expect(screen.getByText(/label assumed/)).toBeTruthy();
    expect(screen.queryByText(/By declared classification/)).toBeNull();
  });
});
