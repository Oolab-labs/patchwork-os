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

const YAML = "name: morning-brief\ntrigger: cron\n";

function routeMock(opts: {
  runs: unknown[];
  halts?: unknown;
  doctor?: unknown;
}): (url: string | URL) => Promise<Response> {
  return (url) => {
    const u = String(url);
    if (u.includes("/recipes/doctor"))
      return Promise.resolve(jsonResponse(opts.doctor ?? { static: { issues: [] }, ok: true }));
    if (u.includes("/runs/halt-summary"))
      return Promise.resolve(
        jsonResponse(opts.halts ?? { total: 0, byCategory: {}, recent: [] }),
      );
    if (u.includes("/runs")) return Promise.resolve(jsonResponse({ runs: opts.runs }));
    if (u.includes("/connectors/status"))
      return Promise.resolve(jsonResponse({ connectors: [] }));
    // Single-recipe raw-YAML fetch (What it does card).
    if (u.match(/\/recipes\/morning-brief(\?|$)/)) return Promise.resolve(jsonResponse(YAML));
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

describe("Recipe page — Overview body (Dossier)", () => {
  it("'Needs you' band renders a plain sentence + fix button on a halted last run", async () => {
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
    expect(await screen.findByText("Needs you")).toBeTruthy();
    expect(container.textContent).toMatch(/can't sign in/i);
    expect(screen.getByRole("link", { name: "Reconnect" })).toBeTruthy();
  });

  it("healthy last run → no 'Needs you' band; run history shows the run", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [{ seq: 9, recipe: "morning-brief", recipeName: "morning-brief", startedAt: 2000, status: "done", durationMs: 42000 }],
      }),
    );
    renderPage();
    await screen.findByText("Run history");
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.getAllByText("#9").length).toBeGreaterThan(0);
  });

  it("'What it does' renders the raw recipe YAML", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [],
      }),
    );
    const { container } = renderPage();
    await screen.findByText("What it does");
    await waitFor(() => expect(container.textContent).toContain("morning-brief"));
    expect(container.querySelector(".rd-yaml")).toBeTruthy();
  });

  it("doctor blockers card only renders when the doctor summary reports issues", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [],
        doctor: {
          ok: false,
          static: {
            issues: [
              { level: "error", code: "missing_step", message: "Step 'notify' has no agent.", stepId: "notify" },
            ],
          },
        },
      }),
    );
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText(/Why hasn't this run\?/)).toBeTruthy());
    expect(container.textContent).toContain("1 blocker");
    expect(container.textContent).toContain("Step 'notify' has no agent.");
  });

  it("no doctor blockers → the 'Why hasn't this run?' card is absent", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [],
        doctor: { ok: true, static: { issues: [] } },
      }),
    );
    renderPage();
    await screen.findByText("What it does");
    expect(screen.queryByText(/Why hasn't this run\?/)).toBeNull();
  });

  it("no runs yet → run history shows the empty state", async () => {
    fetchMock.mockImplementation(routeMock({ runs: [] }));
    renderPage();
    await screen.findByText("Run history");
    expect(screen.getByText(/No runs yet/)).toBeTruthy();
  });

  it("Danger zone (delete) is folded by default and revealed by Show details", async () => {
    fetchMock.mockImplementation(
      routeMock({
        runs: [{ seq: 9, recipe: "morning-brief", recipeName: "morning-brief", startedAt: 2000, status: "done" }],
      }),
    );
    renderPage();
    await screen.findByText("Run history");
    expect(screen.queryByText("Delete this recipe")).toBeNull();
    expect(screen.queryByText("Preview what it would do")).toBeNull();
    expect(screen.queryByText("Check for problems")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    await waitFor(() => expect(screen.getByText("Delete this recipe")).toBeTruthy());
    expect(screen.getByText("Preview what it would do")).toBeTruthy();
    expect(screen.getByText("Check for problems")).toBeTruthy();
  });
});
