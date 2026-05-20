/**
 * Regression test for the React key collision on the Insights tool table.
 *
 * The bridge can return the same `toolName` more than once in its
 * `/api/bridge/insights` payload (a tool exposed under two MCP
 * namespaces, or an aggregation bug). The table previously keyed each
 * <tr> by `toolName` alone, so duplicate names produced
 *   "Encountered two children with the same key, `Bash(pkill:*)`"
 * — the exact symptom from the UI audit. Keys now suffix the row index.
 *
 * This test renders the page with a deliberately duplicated tool name
 * and asserts React logs no key-collision error.
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The insights page uses useSearchParams()/useRouter() (added with the
// ?tool= deep-link support). Without the app-router context those hooks
// throw "invariant expected app router to be mounted" — so mock the
// module: empty search params + a no-op router.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/insights",
}));

import InsightsPage from "@/app/insights/page";

const DUP_PAYLOAD = {
  generatedAt: new Date().toISOString(),
  totalDecisions: 4,
  rejectedToolCount: 0,
  trustedToolCount: 2,
  tools: [
    {
      toolName: "Bash(pkill:*)",
      approvals: 3,
      rejections: 0,
      approvalRate: 1,
      lastDecisionAt: new Date().toISOString(),
      firstDecisionAt: new Date().toISOString(),
      heuristicLabel: "trusted",
      severity: "low" as const,
    },
    {
      // SAME toolName — the collision trigger.
      toolName: "Bash(pkill:*)",
      approvals: 1,
      rejections: 0,
      approvalRate: 1,
      lastDecisionAt: new Date().toISOString(),
      firstDecisionAt: new Date().toISOString(),
      heuristicLabel: "trusted",
      severity: "low" as const,
    },
  ],
};

describe("Insights page — tool table key uniqueness", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(DUP_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("renders duplicate tool names without a React key collision", async () => {
    const { findAllByText } = render(<InsightsPage />);
    // Both rows for the duplicated tool render.
    await waitFor(async () => {
      const cells = await findAllByText("Bash(pkill:*)");
      expect(cells.length).toBe(2);
    });
    // No "two children with the same key" error was logged.
    const keyCollision = consoleErrorSpy.mock.calls.some((args: unknown[]) =>
      args.some(
        (a: unknown) => typeof a === "string" && a.includes("the same key"),
      ),
    );
    expect(keyCollision).toBe(false);
  });
});
