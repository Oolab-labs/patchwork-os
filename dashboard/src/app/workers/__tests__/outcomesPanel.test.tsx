/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const EMPTY_SHADOW = { workers: [], runsScanned: 0, decisionsScanned: 0 };
const ISSUE_URL = "https://github.com/o/r/issues/9";
const OUTCOMES = {
  outcomes: [
    {
      issueUrl: ISSUE_URL,
      disposition: "unknown",
      checkedAt: 1,
      recipeName: "triage-failing-tests-autofile",
      workerClass: "issue:compensable:high",
    },
  ],
};

// The page fetches /workers/shadow, /approvals/kpi, /outcomes, and
// /outcomes/pending. Route each; distinguish the GET poll from the
// Confirm/Reject POST by method. `/outcomes/pending` is matched BEFORE the bare
// `/outcomes` (the latter substring-matches the former).
function routeMock(
  outcomes: unknown = OUTCOMES,
  pending: unknown = { pending: [] },
): (url: string | URL, opts?: RequestInit) => Promise<Response> {
  return (url, opts) => {
    const u = String(url);
    if (u.includes("/approvals/kpi"))
      return Promise.resolve(jsonResponse({ total: 0 }));
    if (u.includes("/outcomes/pending"))
      return Promise.resolve(jsonResponse(pending));
    if (u.includes("/outcomes")) {
      if (opts?.method === "POST")
        return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse(outcomes));
    }
    return Promise.resolve(jsonResponse(EMPTY_SHADOW));
  };
}

describe("FiledOutcomesPanel (on /workers)", () => {
  it("renders filed outcomes with a disposition pill + issue link + context", async () => {
    fetchMock.mockImplementation(routeMock());
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText(/Filed outcomes/)).toBeTruthy();
    expect(container.textContent).toContain(ISSUE_URL);
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).toContain("issue:compensable:high");
  });

  it("POSTs the confirm disposition + flips the pill after the refetch (closes the loop)", async () => {
    // Stateful mock: the POST records the disposition; later GETs reflect it, so
    // a dropped refetch() would leave the pill stuck on "unknown" and fail this.
    let current = "unknown";
    fetchMock.mockImplementation((url: string | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/approvals/kpi"))
        return Promise.resolve(jsonResponse({ total: 0 }));
      if (u.includes("/outcomes")) {
        if (opts?.method === "POST") {
          current = JSON.parse(opts.body as string).disposition;
          return Promise.resolve(jsonResponse({ ok: true }));
        }
        return Promise.resolve(
          jsonResponse({
            outcomes: [{ ...OUTCOMES.outcomes[0], disposition: current }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(EMPTY_SHADOW));
    });
    render(<WorkersPage />);
    const confirmBtn = await screen.findByRole("button", { name: "Confirm" });
    fireEvent.click(confirmBtn);
    // The POST carried the right disposition…
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/outcomes") && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(
        JSON.parse((postCall as [string, RequestInit])[1].body as string),
      ).toEqual({ issueUrl: ISSUE_URL, disposition: "confirmed" });
    });
    // …and refetch() flipped the pill to confirmed (the queue updated).
    expect(await screen.findByText("confirmed")).toBeTruthy();
  });

  it("renders no panel when no outcomes are filed", async () => {
    fetchMock.mockImplementation(routeMock({ outcomes: [] }));
    render(<WorkersPage />);
    // The page still renders (empty workers → its own empty state)…
    expect(await screen.findByText(/No workers yet/)).toBeTruthy();
    // …but the outcomes panel suppresses itself when the queue is empty.
    expect(screen.queryByText(/Filed outcomes/)).toBeNull();
  });
});

const PENDING = {
  pending: [
    {
      issueUrl: "https://github.com/o/r/issues/42",
      recipeName: "file-issues",
      workerId: "filer",
      workerName: "Filer",
      filedAt: 1,
      classKey: "issue:compensable:high",
    },
  ],
};

describe("AwaitingConfirmationPanel (the confirm queue on /workers)", () => {
  it("renders pending filings + a count, suppressed when the queue is empty", async () => {
    // Empty pending → panel absent.
    fetchMock.mockImplementation(routeMock({ outcomes: [] }, { pending: [] }));
    const { unmount } = render(<WorkersPage />);
    await screen.findByText(/No workers yet/);
    expect(screen.queryByText(/Awaiting confirmation/)).toBeNull();
    unmount();

    // Non-empty pending → panel renders the URL + count.
    fetchMock.mockImplementation(routeMock({ outcomes: [] }, PENDING));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText(/Awaiting confirmation/)).toBeTruthy();
    expect(container.textContent).toContain(
      "https://github.com/o/r/issues/42",
    );
    expect(container.textContent).toContain("1 pending");
  });

  it("Confirm POSTs disposition + audit context (recipe + class) for a pending filing", async () => {
    fetchMock.mockImplementation(routeMock({ outcomes: [] }, PENDING));
    render(<WorkersPage />);
    const confirmBtn = await screen.findByRole("button", { name: "Confirm" });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/outcomes") && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(
        JSON.parse((postCall as [string, RequestInit])[1].body as string),
      ).toEqual({
        issueUrl: "https://github.com/o/r/issues/42",
        disposition: "confirmed",
        recipeName: "file-issues",
        workerClass: "issue:compensable:high",
      });
    });
  });
});
