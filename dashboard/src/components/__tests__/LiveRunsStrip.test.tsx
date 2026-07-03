/**
 * Coverage for the Stop control on <LiveRunsStrip/> — the Overview page's
 * "what's running now" strip (embedded directly in app/page.tsx, not via
 * GlobalLiveRunsStrip). Confirms the running -> cancelling -> cancelled
 * happy path and the failure-reverts-to-running path, gated behind the
 * shared CancelRunDialog confirm step.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRunsStrip, type LiveRun } from "@/components/LiveRunsStrip";

function baseRun(partial: Partial<LiveRun>): LiveRun {
  return {
    seq: 501,
    recipe: "nightly-review",
    recipeName: "nightly-review",
    startedAt: Date.now() - 5000,
    status: "running",
    ...partial,
  };
}

describe("<LiveRunsStrip/> Stop control", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a Stop button for a live run and opens a confirm dialog first", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<LiveRunsStrip runs={[baseRun({})]} />);

    const stopBtn = screen.getByTitle("Stop nightly-review");
    expect(stopBtn).toBeInTheDocument();

    await user.click(stopBtn);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Stop this run?")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not render a Stop button for a finished run", () => {
    render(
      <LiveRunsStrip
        runs={[baseRun({ status: "done", doneAt: Date.now(), durationMs: 1200 })]}
      />,
    );
    expect(screen.queryByTitle("Stop nightly-review")).not.toBeInTheDocument();
  });

  it("confirming calls POST /api/bridge/runs/:seq/cancel and flips the row to cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cancelled: true, seq: 501 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<LiveRunsStrip runs={[baseRun({})]} />);

    await user.click(screen.getByTitle("Stop nightly-review"));
    await user.click(screen.getByRole("button", { name: "Stop run" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/bridge/runs/501/cancel");
    expect(init.method).toBe("POST");

    await waitFor(() => {
      expect(screen.getByText("cancelled")).toBeInTheDocument();
    });
    expect(screen.queryByTitle("Stop nightly-review")).not.toBeInTheDocument();
  });

  it("reverts to running and keeps the Stop button on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<LiveRunsStrip runs={[baseRun({})]} />);

    await user.click(screen.getByTitle("Stop nightly-review"));
    await user.click(screen.getByRole("button", { name: "Stop run" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTitle("Stop nightly-review")).not.toBeDisabled();
    });
    expect(screen.queryByText("cancelled")).not.toBeInTheDocument();
  });
});
