/**
 * Regression test for the duplicate React key bug in the global live-runs
 * strip.
 *
 * The strip renders one row per live/recent run. It used to key each row
 * by `r.recipeName`, but the same recipe can be in flight more than once
 * (e.g. recipe "r" with many runs). When two visible rows shared a
 * recipeName, React logged "Encountered two children with the same key"
 * and dropped/duplicated rows. The sibling <LiveRunsStrip/> already used a
 * safe composite key — this is the "fix one path, miss the sibling" case.
 *
 * The component reads its data via the `useActiveRuns()` hook (a module
 * singleton store keyed by recipeName), NOT via props — so we mock the
 * hook to inject two runs that share a recipeName but have distinct
 * runSeq, then assert React never warns about duplicate keys.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRunState } from "@/hooks/useRecipeRunStream";

// Mock the live-runs store so we control exactly which runs the strip
// sees. `useActiveRuns` is the only export the component consumes.
const mockRuns = vi.fn<() => Map<string, ActiveRunState>>();
vi.mock("@/hooks/LiveRunsContext", () => ({
  useActiveRuns: () => mockRuns(),
}));

import { GlobalLiveRunsStrip } from "@/components/GlobalLiveRunsStrip";

function run(partial: Partial<ActiveRunState>): ActiveRunState {
  return {
    runSeq: 0,
    recipeName: "r",
    totalSteps: 3,
    doneSteps: 1,
    startedAt: Date.now(),
    status: "running",
    ...partial,
  };
}

describe("<GlobalLiveRunsStrip/>", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    mockRuns.mockReset();
    vi.unstubAllGlobals();
  });

  it("does not warn about duplicate keys when one recipe has multiple runs", () => {
    // Two runs of the same recipe ("r") with distinct runSeq. A Map can
    // hold these under different keys even though they share recipeName —
    // exactly what the bridge stream yields when a recipe runs repeatedly.
    const m = new Map<string, ActiveRunState>();
    m.set("r#1", run({ recipeName: "r", runSeq: 101, status: "running" }));
    m.set("r#2", run({ recipeName: "r", runSeq: 102, status: "running" }));
    m.set("r#3", run({ recipeName: "r", runSeq: 103, status: "ok" }));
    mockRuns.mockReturnValue(m);

    const { container } = render(<GlobalLiveRunsStrip />);

    // The strip rendered rows (it is not the auto-hide empty state).
    expect(container.querySelectorAll(".global-live-runs-strip-row").length).toBeGreaterThan(1);

    // React must not have logged a duplicate-key warning.
    const sawDupKey = errorSpy.mock.calls.some((args: unknown[]) =>
      args.some((a) => typeof a === "string" && /same key/i.test(a)),
    );
    expect(sawDupKey).toBe(false);
  });

  it("renders distinct rows for runs that share a recipeName", () => {
    const m = new Map<string, ActiveRunState>();
    m.set("r#1", run({ recipeName: "r", runSeq: 201, status: "running" }));
    m.set("r#2", run({ recipeName: "r", runSeq: 202, status: "running" }));
    mockRuns.mockReturnValue(m);

    const { container } = render(<GlobalLiveRunsStrip />);

    // Both runs have runSeq > 0 → both render as <Link> to /runs/<seq>.
    expect(container.querySelector('a[href="/runs/201"]')).not.toBeNull();
    expect(container.querySelector('a[href="/runs/202"]')).not.toBeNull();
  });

  describe("Stop control", () => {
    function seedOneRunningRow() {
      const m = new Map<string, ActiveRunState>();
      m.set("r#1", run({ recipeName: "r", runSeq: 301, status: "running" }));
      mockRuns.mockReturnValue(m);
    }

    it("shows a Stop button only for the running row and opens a confirm dialog", async () => {
      seedOneRunningRow();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GlobalLiveRunsStrip />);

      const stopBtn = screen.getByTitle("Stop r");
      expect(stopBtn).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      await user.click(stopBtn);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Stop this run?")).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("confirming calls POST /api/bridge/runs/:seq/cancel and shows Cancelled on success", async () => {
      seedOneRunningRow();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ cancelled: true, seq: 301 }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GlobalLiveRunsStrip />);

      await user.click(screen.getByTitle("Stop r"));
      await user.click(screen.getByRole("button", { name: "Stop run" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/bridge/runs/301/cancel");
      expect(init.method).toBe("POST");

      await waitFor(() => {
        expect(screen.getByText("Cancelled")).toBeInTheDocument();
      });
      // Optimistic override also hides the Stop button for that row.
      expect(screen.queryByTitle("Stop r")).not.toBeInTheDocument();
    });

    it("reverts to running on failure", async () => {
      seedOneRunningRow();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ cancelled: false, seq: 301 }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GlobalLiveRunsStrip />);

      await user.click(screen.getByTitle("Stop r"));
      await user.click(screen.getByRole("button", { name: "Stop run" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      // Row still shows the live status, Stop button still present/enabled.
      await waitFor(() => {
        const stopBtn = screen.getByTitle("Stop r");
        expect(stopBtn).not.toBeDisabled();
      });
      expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
    });
  });
});
