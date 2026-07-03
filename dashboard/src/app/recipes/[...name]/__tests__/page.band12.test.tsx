/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The default export unwraps `params` with React.use(); stable React 18.3 in
// the test env doesn't export `use` (Next supplies it in the real build), so
// mock it to synchronously read a value we attach to the resolved promise.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    use: (p: unknown) =>
      p && typeof (p as { then?: unknown }).then === "function"
        ? (p as { _testValue?: unknown })._testValue
        : (actual as { use?: (x: unknown) => unknown }).use?.(p),
  };
});

// The recipe page uses useRouter()/useSearchParams(); mock next/navigation so
// the app-router hooks don't throw outside an app-router context.
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
  usePathname: () => "/recipes/morning-brief",
}));

import RecipePage from "../page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const RECIPE = {
  name: "morning-brief",
  trigger: "cron",
  schedule: "0 7 * * *",
  enabled: true,
  stepCount: 3,
};

function routeMock(opts: {
  runs: unknown[];
  halts?: unknown;
}): (url: string | URL) => Promise<Response> {
  return (url) => {
    const u = String(url);
    if (u.includes("/recipes/doctor")) return Promise.resolve(jsonResponse({}));
    if (u.includes("/runs/halt-summary"))
      return Promise.resolve(
        jsonResponse(opts.halts ?? { total: 0, byCategory: {}, recent: [] }),
      );
    if (u.includes("/runs")) return Promise.resolve(jsonResponse({ runs: opts.runs }));
    if (u.includes("/connectors/status"))
      return Promise.resolve(jsonResponse({ connectors: [] }));
    if (u.includes("/recipes")) return Promise.resolve(jsonResponse([RECIPE]));
    // Simulation + anything else → empty.
    return Promise.resolve(jsonResponse({}));
  };
}

function renderPage() {
  const params = Object.assign(Promise.resolve({ name: ["morning-brief"] }), {
    _testValue: { name: ["morning-brief"] },
  });
  return render(<RecipePage params={params} />);
}

describe("Recipe page — Band 1 status + Band 2 needs-you (R1)", () => {
  it("halted last run → red medallion + a 'Needs you' band with a fix button", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [{ seq: 5, recipe: "morning-brief", recipeName: "morning-brief", startedAt: 1000, status: "error" }],
        halts: {
          total: 1,
          byCategory: { auth_failure: 1 },
          recent: [{ reason: "token expired", category: "auth_failure", runSeq: 5 }],
        },
      }),
    );
    const { container } = renderPage();
    expect(await screen.findByText("Stopped — needs attention")).toBeTruthy();
    // Band 2 present, plain sentence + a reconnect fix.
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(container.textContent).toMatch(/can't sign in/i);
    expect(screen.getByRole("link", { name: "Reconnect" })).toBeTruthy();
  });

  it("healthy last run → green 'Working fine', no needs band, human schedule", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [{ seq: 9, recipe: "morning-brief", recipeName: "morning-brief", startedAt: 2000, status: "done", durationMs: 42000 }],
      }),
    );
    const { container } = renderPage();
    expect(await screen.findByText("Working fine")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
    // Plain schedule, not a raw cron string, in the default view.
    expect(container.textContent).toContain("Every day at 7:00");
  });

  it("actions read 'Pause' (not 'Disable'); delete is folded in a danger zone", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [{ seq: 9, recipe: "morning-brief", recipeName: "morning-brief", startedAt: 2000, status: "done" }],
      }),
    );
    const { container } = renderPage();
    await screen.findByText("Working fine");
    // Renamed control.
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(container.textContent).not.toContain("Uninstall");
    // Danger zone is folded by default…
    expect(screen.queryByText("Delete this recipe")).toBeNull();
    // …and revealed by the page-level Show details toggle.
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    await waitFor(() => expect(screen.getByText("Delete this recipe")).toBeTruthy());
  });
});
