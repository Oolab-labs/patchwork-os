/**
 * Regression: batchDecide() (the "Reject selected" bulk action) built its
 * own inline `fetch(POST)` with no body, instead of reusing decide() — the
 * function the single-item reject path uses. Two things silently regressed
 * on the bulk path as a result:
 *
 *   1. decide() collects and POSTs an audit `reason` for high-tier rejects
 *      (see handleDecide's window.prompt). batchDecide never captured or
 *      sent one — every high-tier bulk rejection was logged with no
 *      justification, exactly the audit-provenance gap the single-item
 *      path was hardened against.
 *   2. decide() treats a 409 (another session already decided the call) as
 *      success and fades the card out. batchDecide's raw fetch treated any
 *      non-ok status — including 409 — as a failure, producing a
 *      confusing false-error toast for an already-resolved item.
 *
 * Both are fixed by having batchDecide reuse decide() instead of a second,
 * unhardened fetch call.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/approvals",
}));

import ApprovalsPage from "../page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HIGH_TIER_APPROVAL = {
  callId: "aaaaaaaa-1111-1111-1111-111111111111",
  toolName: "runCommand",
  tier: "high" as const,
  requestedAt: Date.now(),
  summary: "rm -rf /tmp/scratch",
};

let fetchMock: ReturnType<typeof vi.fn>;
let promptSpy: ReturnType<typeof vi.spyOn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // jsdom has no scrollIntoView implementation; the page calls it from a
  // keyboard-focus effect that fires on mount.
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no EventSource — the page's polling fallback fires
  // immediately via fetch(`${API}/approvals`), no fake timers needed.
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/api/bridge/approvals") && !url.includes("stream")) {
      return jsonResponse([HIGH_TIER_APPROVAL]);
    }
    if (url.includes("/api/bridge/cc-permissions")) {
      return jsonResponse(null);
    }
    return jsonResponse({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  promptSpy = vi.spyOn(window, "prompt").mockReturnValue("looked malicious, blocking");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function selectAndRejectHighTierApproval() {
  render(<ApprovalsPage />);

  const checkbox = await screen.findByLabelText(
    /Select runCommand approval aaaaaaaa/i,
  );
  fireEvent.click(checkbox);

  const rejectBtn = await screen.findByText(/Reject selected/i);
  fireEvent.click(rejectBtn);
}

describe("batchDecide — bulk reject reuses decide()'s audit-reason + 409 handling", () => {
  it("prompts once for a reason and POSTs it as the request body for a high-tier bulk reject", async () => {
    await selectAndRejectHighTierApproval();

    await waitFor(() => {
      const rejectCall = fetchMock.mock.calls.find(
        (c) =>
          (c[1] as RequestInit | undefined)?.method === "POST" &&
          (c[0] as string).includes(`/reject/${HIGH_TIER_APPROVAL.callId}`),
      );
      expect(rejectCall).toBeDefined();
    });

    expect(promptSpy).toHaveBeenCalledTimes(1);
    const rejectCall = fetchMock.mock.calls.find(
      (c) =>
        (c[1] as RequestInit | undefined)?.method === "POST" &&
        (c[0] as string).includes(`/reject/${HIGH_TIER_APPROVAL.callId}`),
    )!;
    const init = rejectCall[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      reason: "looked malicious, blocking",
    });
  });

  it("does not send a reason and does not prompt when the user cancels the reason prompt", async () => {
    promptSpy.mockReturnValue(null);
    await selectAndRejectHighTierApproval();

    // Give any (incorrect) fetch a tick to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 10));
    const rejectCall = fetchMock.mock.calls.find(
      (c) =>
        (c[1] as RequestInit | undefined)?.method === "POST" &&
        (c[0] as string).includes(`/reject/${HIGH_TIER_APPROVAL.callId}`),
    );
    expect(rejectCall).toBeUndefined();
  });

  it("treats a 409 (already decided elsewhere) as success, not a bulk-reject failure", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/api/bridge/approvals") && !url.includes("stream")) {
        return jsonResponse([HIGH_TIER_APPROVAL]);
      }
      if (url.includes("/api/bridge/cc-permissions")) return jsonResponse(null);
      if (method === "POST" && url.includes(`/reject/${HIGH_TIER_APPROVAL.callId}`)) {
        return jsonResponse({ error: "already decided" }, 409);
      }
      return jsonResponse({}, 404);
    });

    await selectAndRejectHighTierApproval();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (c) =>
            (c[1] as RequestInit | undefined)?.method === "POST" &&
            (c[0] as string).includes(`/reject/${HIGH_TIER_APPROVAL.callId}`),
        ),
      ).toBe(true);
    });

    // No "reject failed for: ..." banner — the 409 must be swallowed as
    // success by decide(), same as the single-item path.
    expect(screen.queryByText(/reject failed for/i)).toBeNull();
  });
});
