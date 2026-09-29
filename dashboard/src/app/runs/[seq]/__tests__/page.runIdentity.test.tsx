/**
 * The run page must load the run the link named. A run number is only unique
 * per bridge; `?task=` carries the run's real identity, and without it the
 * page must say when the number is shared rather than silently show one run.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ seq: "7" }),
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/runs/7",
}));
vi.mock("@/hooks/useBridgeStream", () => ({ useBridgeStream: () => {} }));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import RunDetailPage from "../page";

const run = {
  seq: 7,
  taskId: "yaml:example-x:1",
  recipeName: "example-x",
  trigger: "cron",
  status: "done",
  createdAt: 1,
  startedAt: 1,
  doneAt: 2,
  durationMs: 1,
  stepResults: [],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes("/by-task/")
        ? { run }
        : { run, sameSeqTaskIds: ["yaml:example-x:1", "yaml:example-y:1"] },
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  search = new URLSearchParams();
});

describe("run page identity", () => {
  it("with ?task= it loads the named run through the by-task route", async () => {
    search = new URLSearchParams("task=yaml:example-x:1");
    render(<RunDetailPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/bridge/runs/by-task/yaml%3Aexample-x%3A1"))).toBe(true);
    expect(urls.some((u) => /\/api\/bridge\/runs\/7(\?|$)/.test(u))).toBe(false);
  });

  it("without ?task=, a shared number offers every run instead of guessing", async () => {
    render(<RunDetailPage />);
    const note = await screen.findByText(/is shared by 2 runs/);
    expect(note).toBeTruthy();
    const links = screen.getAllByRole("link", { name: /yaml:example-[xy]:1/ });
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual([
      "/runs/7?task=yaml%3Aexample-x%3A1",
      "/runs/7?task=yaml%3Aexample-y%3A1",
    ]);
  });
});
