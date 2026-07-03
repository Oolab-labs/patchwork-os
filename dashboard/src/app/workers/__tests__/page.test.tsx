/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkersPage from "../page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Expert mode is persisted in localStorage now (shared page-level toggle);
  // clear it so a test that clicks "Show details" doesn't leak expert=true
  // into the next test.
  window.localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const SHADOW = {
  runsScanned: 12,
  decisionsScanned: 30,
  workers: [
    {
      workerId: "release-notes-worker",
      name: "Release Worker",
      autonomyCeiling: 4,
      board: [
        {
          classKey: "fs-write:reversible:medium",
          level: 3,
          observations: 40,
          mean: 0.95,
        },
      ],
      compared: 1,
      agreed: 0,
      divergences: [
        {
          classKey: "vcs-remote:compensable:high",
          toolName: "gitPush",
          ramp: "queue",
          gate: "allow",
          at: 0,
          note: "ramp would gate; gate allowed",
        },
      ],
    },
  ],
};

// The page fetches BOTH /workers/shadow and /approvals/kpi (KPI panel). A fresh
// Response per call is required — a single mockResolvedValue Response can only
// have its body read once, so the second fetch would get an empty/consumed body.
function routeMock(
  shadow: unknown,
  kpi: unknown = { total: 0 },
): (url: string | URL) => Promise<Response> {
  return (url) =>
    Promise.resolve(
      String(url).includes("/approvals/kpi")
        ? jsonResponse(kpi)
        : jsonResponse(shadow),
    );
}

describe("WorkersPage", () => {
  it("renders the plain per-task record; ramp-vs-gate divergence lives under details", async () => {
    fetchMock.mockImplementation(routeMock(SHADOW));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText("Release Worker")).toBeTruthy();
    // The per-task record lives in the worker's drawer — expand the roster row.
    fireEvent.click(screen.getByRole("button", { name: /Release Worker/ }));
    // Plain per-task record: fs-write:reversible:medium (not owned) → "changing files".
    expect(container.textContent).toContain("changing files");
    expect(container.textContent).toContain("not one of its jobs");
    // The ramp-vs-gate divergence is engine-detail — hidden until "Show details".
    expect(container.textContent).not.toContain("gitPush");
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(container.textContent).toContain("gitPush");
    expect(container.textContent).toContain("ramp would gate; gate allowed");
  });

  it("floors a not-owned class and flags it in plain words, not raw levels", async () => {
    const NOT_OWNED_SHADOW = {
      runsScanned: 5,
      decisionsScanned: 5,
      workers: [
        {
          workerId: "release-notes-worker",
          name: "Release Worker",
          autonomyCeiling: 4,
          board: [
            {
              classKey: "other:irreversible:high",
              level: 3,
              observations: 12,
              mean: 0.9,
              owned: false,
            },
          ],
          compared: 0,
          agreed: 0,
          divergences: [],
        },
      ],
    };
    fetchMock.mockImplementation(routeMock(NOT_OWNED_SHADOW));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText("Release Worker")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Release Worker/ }));
    // Not-owned classes must read as "not one of its jobs" (floored), never as
    // the raw earned level (L3) — a worker has no standing trust there.
    expect(container.textContent).toMatch(/not one of its jobs/i);
    expect(container.textContent).not.toContain("L3 act+sample");
  });

  it("surfaces a 'ready for more independence?' headline when earned > ceiling", async () => {
    const READY_SHADOW = {
      runsScanned: 20,
      decisionsScanned: 20,
      workers: [
        {
          workerId: "test-guardian-worker",
          name: "Test Guardian Worker",
          autonomyCeiling: 1,
          board: [
            {
              classKey: "issue:compensable:high",
              level: 4,
              observations: 18,
              mean: 0.96,
              owned: true,
            },
          ],
          compared: 0,
          agreed: 0,
          divergences: [],
        },
      ],
    };
    fetchMock.mockImplementation(routeMock(READY_SHADOW));
    const { container } = render(<WorkersPage />);
    // Collapsed row already flags the promotion via the status chip…
    expect(
      await screen.findByText(/Ready for a promotion/),
    ).toBeTruthy();
    // …the full "Ready for more independence?" block + config change is in the drawer.
    fireEvent.click(
      screen.getByRole("button", { name: /Test Guardian Worker/ }),
    );
    expect(container.textContent).toMatch(/Ready for more independence/);
    expect(container.textContent).toContain("filing issues");
    expect(container.textContent).toContain("autonomyCeiling: 4");
  });

  it("roster row is compact by default — status + standing show; the drawer detail is hidden until expanded", async () => {
    fetchMock.mockImplementation(routeMock(SHADOW));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText("Release Worker")).toBeTruthy();
    // Scannable at a glance: the status chip + a one-line standing are present…
    expect(container.textContent).toContain("Proving itself");
    // …but the drawer's per-task record is NOT in the DOM until the row opens.
    expect(container.textContent).not.toContain("changing files");
    fireEvent.click(screen.getByRole("button", { name: /Release Worker/ }));
    expect(container.textContent).toContain("changing files");
  });

  it("shows the empty state when no workers are configured", async () => {
    fetchMock.mockImplementation(
      routeMock({ workers: [], runsScanned: 0, decisionsScanned: 0 }),
    );
    render(<WorkersPage />);
    expect(await screen.findByText(/No workers set up yet/)).toBeTruthy();
  });

  it("shows the rubber-stamp warning in plain view; telemetry under details", async () => {
    fetchMock.mockImplementation(
      routeMock(SHADOW, {
        total: 8,
        decided: 8,
        approved: 8,
        rejected: 0,
        abandoned: 0,
        rejectRate: 0,
        latency: { count: 8, medianMs: 200, p90Ms: 400 },
        channels: { dashboard: 5, phone: 3 },
        byTool: [
          {
            toolName: "github.create_issue",
            decided: 8,
            rejected: 0,
            rejectRate: 0,
            latency: { count: 8, medianMs: 200, p90Ms: 400 },
            channels: { dashboard: 5, phone: 3 },
          },
        ],
      }),
    );
    const { container } = render(<WorkersPage />);
    // Plain amber warning is shown by default (collapsed into Band 1); raw
    // telemetry is not.
    await screen.findByText(/approved all 8 requests without ever saying no/);
    expect(container.textContent).not.toContain("reject rate 0%");
    expect(container.textContent).not.toContain("rubber-stamping");
    // …the full telemetry + the "rubber-stamping" framing live under details.
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(container.textContent).toContain("reject rate 0%");
    expect(container.textContent).toContain("rubber-stamping");
  });

  it("shows the trust journey — stepper stops + a plain 'how it got here' timeline (climbs AND slips)", async () => {
    const JOURNEY_SHADOW = {
      runsScanned: 20,
      decisionsScanned: 20,
      workers: [
        {
          workerId: "test-guardian-worker",
          name: "Test Guardian Worker",
          autonomyCeiling: 1,
          board: [
            {
              classKey: "issue:compensable:high",
              level: 0,
              observations: 5,
              mean: 0.21,
              owned: true,
            },
          ],
          events: [
            {
              type: "promote",
              classKey: "issue:compensable:high",
              from: 0,
              to: 1,
              at: 1000,
              evidence: 4,
              reason: "sustained evidence",
              workerId: "test-guardian-worker",
            },
            {
              type: "demote",
              classKey: "issue:compensable:high",
              from: 1,
              to: 0,
              at: 2000,
              evidence: 31,
              reason: "a rejected filing",
              workerId: "test-guardian-worker",
            },
          ],
          compared: 0,
          agreed: 0,
          divergences: [],
        },
      ],
    };
    fetchMock.mockImplementation(routeMock(JOURNEY_SHADOW));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText("Test Guardian Worker")).toBeTruthy();
    // The full journey (stepper + history) lives in the drawer — expand it.
    fireEvent.click(
      screen.getByRole("button", { name: /Test Guardian Worker/ }),
    );
    // The journey stepper renders the plain stops.
    expect(container.textContent).toContain("Just watching");
    expect(container.textContent).toContain("Fully trusted");
    // The history: newest first — the slip (demote) then the climb (promote).
    expect(container.textContent).toContain("How it got here");
    expect(container.textContent).toMatch(
      /Slipped back to .Just watching. on filing issues/,
    );
    expect(container.textContent).toMatch(
      /Earned .Asks first. on filing issues/,
    );
  });
});
