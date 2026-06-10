/** @vitest-environment jsdom */
/**
 * Regression (dashboard-ui-1): TelemetrySection previously fired TWO independent
 * mount-time GETs to /api/bridge/telemetry-prefs — one for the endpoint info,
 * one for the toggle values — so the two sections could reflect different server
 * snapshots. The fix merges them into a single fetch.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetrySection } from "../TelemetrySection";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        lastSentAt: "2026-06-10T00:00:00Z",
        endpoint: "https://analytics.example.com/v1/usage",
        endpointSource: "config",
        crashReports: false,
        usageStats: false,
        localDiagnostics: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelemetrySection mount fetches", () => {
  it("fires exactly one GET to /api/bridge/telemetry-prefs on mount", async () => {
    render(<TelemetrySection flashSaved={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Allow any second (buggy) effect to fire before asserting.
    await new Promise((r) => setTimeout(r, 20));

    const prefGets = fetchMock.mock.calls.filter(([url, init]) => {
      const u = typeof url === "string" ? url : String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      return u.includes("/api/bridge/telemetry-prefs") && method === "GET";
    });
    expect(prefGets).toHaveLength(1);
  });
});
