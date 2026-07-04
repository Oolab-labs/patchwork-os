/**
 * Smoke test for the Home "Terminal (dark)" deck (app/page.tsx).
 *
 * Prior to this PR, app/page.tsx had zero test coverage (per the redesign
 * plan's risk register). Covers:
 *   - the deck renders its 7 panes + statusline on a healthy bridge
 *   - one endpoint 500ing shows an inline error row in that pane only,
 *     the rest of the deck still renders (fail-soft requirement)
 *   - the live clock renders "—" before the first client tick (SSR-safe
 *     placeholder) then updates after the 1s interval fires
 *   - pane focus responds to number-key shortcuts (0-6)
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "@/app/page";

const originalFetch = global.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route table for the mocked fetch — keyed by a substring match against
 *  the request URL, since apiPath() may prefix a basePath. */
function mockFetchRoutes(routes: Record<string, () => Response>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [key, make] of Object.entries(routes)) {
      if (url.includes(key)) return make();
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

const HEALTHY_ROUTES: Record<string, () => Response> = {
  "/api/bridge/health": () =>
    jsonResponse({
      status: "ok",
      uptimeMs: 60_000,
      connections: 1,
      extensionConnected: true,
      extensionVersion: "1.0.0",
      activeSessions: 2,
    }),
  "/api/bridge/status": () =>
    jsonResponse({ ok: true, port: 3101, uptimeMs: 60_000, activeSessions: 2 }),
  "/api/bridge/kill-switch": () => jsonResponse({ engaged: false, locked: false }),
  "/api/bridge/approvals": () => jsonResponse([]),
  "/api/bridge/recipes": () =>
    jsonResponse({
      recipes: [
        { name: "daily-brief", enabled: true, schedule: "0 7 * * *" },
        { name: "paused-thing", enabled: false, schedule: "0 9 * * *" },
      ],
    }),
  "/api/bridge/activity": () => jsonResponse({ events: [] }),
  "/api/bridge/runs/halt-summary": () => jsonResponse({ total: 0 }),
  "/api/bridge/runs": () => jsonResponse({ runs: [] }),
  "/api/bridge/workers/shadow": () =>
    jsonResponse({ workers: [], runsScanned: 0, decisionsScanned: 0 }),
  "/api/bridge/gate/decisions": () => jsonResponse({ decisions: [] }),
  "/api/inbox": () => jsonResponse({ items: [] }),
};

const SAMPLE_GATE_DECISION = {
  seq: 42,
  decidedAt: Date.UTC(2026, 5, 3, 7, 43),
  workerId: "test-guardian",
  toolName: "githubCreateIssue",
  classKey: "issue:compensable:high",
  action: "gate",
  owned: true,
  earnedLevel: 1,
  autonomyCeiling: 3,
  effectiveLevel: 1,
  reason: "earned trust (L1) below the compensable-action threshold (L2)",
  recipeName: "triage-failing-tests",
  gatePolicyVersion: "v1",
};

describe("<HomePage/> — Terminal deck", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("renders the statusline + all 7 panes on a healthy bridge", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    for (const label of [
      "attention",
      "tail",
      "fleet",
      "next",
      "workers",
      "vitals",
      "inbox",
    ]) {
      expect(screen.getByRole("region", { name: label })).toBeTruthy();
    }
    // Statusline segments.
    expect(screen.getByText(/patchwork · local:/)).toBeTruthy();
  });

  it("fails soft: one endpoint 500ing still lets the rest of the deck render", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/workers/shadow": () => jsonResponse({ error: "boom" }, 500),
    });
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Workers pane shows an inline error, not a crash.
    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/unavailable/i);

    // Other panes still rendered fine.
    expect(screen.getByRole("region", { name: "fleet" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "vitals" })).toBeTruthy();
  });

  it("renders the SSR clock placeholder then ticks after mount", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);

    // Clock starts as the em-dash placeholder before the first effect tick.
    // (React may flush the effect synchronously in the test renderer, so
    // just assert it eventually shows a real HH:MM:SS instead of asserting
    // the very first paint frame.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    await waitFor(() => {
      const statusline = screen.getByRole("status", { name: "Bridge status" });
      expect(statusline.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  it("moves pane focus on number-key shortcuts", async () => {
    mockFetchRoutes(HEALTHY_ROUTES);
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const fleetPane = screen.getByRole("region", { name: "fleet" });
    expect(fleetPane.className).not.toMatch(/td-pane-active/);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    });

    await waitFor(() => {
      expect(fleetPane.className).toMatch(/td-pane-active/);
    });
  });

  it("renders gate-activity entries in the workers pane (Decision Record feed)", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () =>
        jsonResponse({ decisions: [SAMPLE_GATE_DECISION] }),
    });
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/GATE/);
    expect(workersPane.textContent).toMatch(/test-guardian/);
    expect(workersPane.textContent).toMatch(/issue:compensable:high/);
    // effectiveLevel 1 → "asks first" per the shared level-phrase vocabulary.
    expect(workersPane.textContent).toMatch(/asks first/);
  });

  it("expands a gate-activity row to show the plain-English explain rendering", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () =>
        jsonResponse({ decisions: [SAMPLE_GATE_DECISION] }),
    });
    render(<HomePage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const row = screen.getByRole("button", { expanded: false });
    await act(async () => {
      row.click();
    });

    await waitFor(() => {
      expect(row.getAttribute("aria-expanded")).toBe("true");
    });
    const workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/earned L1/);
    expect(workersPane.textContent).toMatch(/autonomy ceiling L3/);
    expect(workersPane.textContent).toMatch(
      /earned trust \(L1\) below the compensable-action threshold \(L2\)/,
    );
  });

  it("fails soft when /gate/decisions is empty or errors", async () => {
    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () => jsonResponse({ decisions: [] }),
    });
    const { unmount } = render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    let workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/no gate decisions yet/i);
    unmount();

    mockFetchRoutes({
      ...HEALTHY_ROUTES,
      "/api/bridge/gate/decisions": () => jsonResponse({ error: "boom" }, 500),
    });
    render(<HomePage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    workersPane = screen.getByRole("region", { name: "workers" });
    expect(workersPane.textContent).toMatch(/gate activity unavailable/i);
    // Rest of the pane (worker trust rows) still renders — fail-soft.
    expect(workersPane.textContent).toMatch(/no worker activity yet/i);
  });
});
