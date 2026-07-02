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
// confirm/reject POST by method. `/outcomes/pending` is matched BEFORE the bare
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
  it("renders reviewed outcomes with a plain verdict pill + issue link + task", async () => {
    fetchMock.mockImplementation(routeMock());
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText(/Did the workers get it right/)).toBeTruthy();
    expect(container.textContent).toContain(ISSUE_URL);
    // Plain verdict for "unknown" + plain task for issue:compensable:high.
    expect(container.textContent).toContain("not reviewed");
    expect(container.textContent).toContain("filing issues");
  });

  it("Looks real POSTs the confirm verdict + flips the pill after refetch (closes the loop)", async () => {
    // Stateful mock: the POST records the disposition; later GETs reflect it, so
    // a dropped refetch() would leave the pill stuck on "not reviewed" and fail.
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
    const confirmBtn = await screen.findByRole("button", { name: "Looks real" });
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
    // …and refetch() flipped the pill to the plain "looks real" (the queue updated).
    expect(await screen.findByText("looks real")).toBeTruthy();
  });

  it("renders no panel when nothing has been filed", async () => {
    fetchMock.mockImplementation(routeMock({ outcomes: [] }));
    render(<WorkersPage />);
    // The page still renders (empty workers → its own empty state)…
    expect(await screen.findByText(/No workers set up yet/)).toBeTruthy();
    // …but the outcomes panel suppresses itself when there is nothing to review.
    expect(screen.queryByText(/Did the workers get it right/)).toBeNull();
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

describe("AwaitingConfirmationPanel (the review queue on /workers)", () => {
  it("renders items needing review + a count, all-caught-up when empty", async () => {
    // Empty queue, endpoint answered 200 → all-caught-up affirmation (not absent).
    fetchMock.mockImplementation(routeMock({ outcomes: [] }, { pending: [] }));
    const { container: emptyC, unmount } = render(<WorkersPage />);
    expect(await screen.findByText(/all caught up/)).toBeTruthy();
    expect(emptyC.textContent).toContain("0 waiting");
    unmount();

    // Non-empty → panel renders the URL + count.
    fetchMock.mockImplementation(routeMock({ outcomes: [] }, PENDING));
    const { container } = render(<WorkersPage />);
    expect(await screen.findByText(/Needs your review/)).toBeTruthy();
    expect(container.textContent).toContain(
      "https://github.com/o/r/issues/42",
    );
    expect(container.textContent).toContain("1 waiting");
  });

  it("suppresses the panel entirely on a bridge too old to serve /outcomes/pending (404)", async () => {
    // 404 → useBridgeFetch treats it as terminal (status 404, data null); the
    // panel must NOT render the all-caught-up affirmation (which would
    // false-signal "drained" on a bridge that simply lacks the endpoint).
    fetchMock.mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/approvals/kpi"))
        return Promise.resolve(jsonResponse({ total: 0 }));
      if (u.includes("/outcomes/pending"))
        return Promise.resolve(jsonResponse({ error: "not found" }, 404));
      if (u.includes("/outcomes"))
        return Promise.resolve(jsonResponse({ outcomes: [] }));
      return Promise.resolve(jsonResponse(EMPTY_SHADOW));
    });
    render(<WorkersPage />);
    await screen.findByText(/No workers set up yet/);
    expect(screen.queryByText(/Needs your review/)).toBeNull();
  });

  it("Looks real POSTs the verdict + audit context (recipe + class) for a queued item", async () => {
    fetchMock.mockImplementation(routeMock({ outcomes: [] }, PENDING));
    render(<WorkersPage />);
    const confirmBtn = await screen.findByRole("button", { name: "Looks real" });
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
