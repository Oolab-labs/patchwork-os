/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
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
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it("renders the trust dial + a ramp-vs-gate divergence from the shadow endpoint", async () => {
    fetchMock.mockImplementation(routeMock(SHADOW));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText("Release Worker")).toBeTruthy();
    // the divergence text is split across nodes (⚠ {tool} — {note}); assert on
    // the rendered textContent rather than an exact single-node match
    expect(container.textContent).toContain("gitPush");
    expect(container.textContent).toContain("ramp would gate; gate allowed");
  });

  it("floors a not-owned class to L0 and flags it, instead of rendering it as earned trust", async () => {
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
    // Not-owned classes must render as NOT OWNED / floored to L0, not as the
    // raw earned level (L3) — a worker has no standing trust on classes it
    // doesn't own, regardless of accrued evidence.
    expect(container.textContent).toMatch(/NOT OWNED/i);
    expect(container.textContent).not.toContain("L3 act+sample");
  });

  it("shows the empty state when no workers are configured", async () => {
    fetchMock.mockImplementation(
      routeMock({ workers: [], runsScanned: 0, decisionsScanned: 0 }),
    );
    render(<WorkersPage />);
    expect(await screen.findByText(/No workers yet/)).toBeTruthy();
  });

  it("renders the considered-approval panel with the rubber-stamp warning", async () => {
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
    expect(await screen.findByText(/Considered approvals/)).toBeTruthy();
    expect(container.textContent).toContain("reject rate 0%");
    // 8 decided, 0 rejected → the rubber-stamp warning must fire
    expect(container.textContent).toMatch(/rubber-stamps/);
  });
});
