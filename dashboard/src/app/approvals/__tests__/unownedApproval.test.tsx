/**
 * ADR-0018 point 4: "`unowned` is visible, not silent."
 *
 * An entry restored from the durable log after a bridge restart has no
 * waiting caller — approving it records the decision but performs nothing.
 * The ADR is explicit that this must be shown, because an operator who
 * believes otherwise has been misled about whether the action happened,
 * and the whole product is that a person can trust what a screen tells
 * them about authority.
 *
 * These assert the three places that could mislead: the card badge, the
 * body copy, and the high-tier approve confirm (whose normal wording,
 * "this cannot be undone", is exactly backwards for an entry that runs
 * nothing).
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

const BASE = {
  callId: "aaaaaaaa-1111-1111-1111-111111111111",
  toolName: "runCommand",
  tier: "high" as const,
  requestedAt: Date.now(),
  summary: "rm -rf /tmp/scratch",
};

/**
 * The confirm-wording cases drive the Approve button, which for an
 * irreversible tool (`runCommand` → shell) is held behind the evidence
 * gate. Use a high-tier but reversible-class tool so the test exercises
 * the confirm text rather than the unrelated evidence lock.
 */
const REVERSIBLE_HIGH = {
  ...BASE,
  toolName: "editText",
  summary: "rewrite config",
};

let fetchMock: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;

function mountWith(approval: Record<string, unknown>) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (
      method === "GET" &&
      url.includes("/api/bridge/approvals") &&
      !url.includes("stream")
    ) {
      return jsonResponse([approval]);
    }
    if (url.includes("/api/bridge/cc-permissions")) {
      return jsonResponse(null);
    }
    return jsonResponse({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ApprovalsPage />);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "prompt").mockReturnValue("reason");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unowned (restored) approvals are visibly distinguished", () => {
  it("shows a 'No waiting caller' badge when owned is false", async () => {
    mountWith({ ...BASE, owned: false });
    expect(await screen.findByText(/No waiting caller/i)).toBeTruthy();
  });

  it("explains in the card body that approving records but does not run", async () => {
    mountWith({ ...BASE, owned: false });
    expect(
      await screen.findByText(/does not run the action/i),
    ).toBeTruthy();
  });

  it("does NOT show the badge for a live (owned) entry", async () => {
    mountWith({ ...BASE, owned: true });
    await screen.findByText(/rm -rf/i); // card rendered
    expect(screen.queryByText(/No waiting caller/i)).toBeNull();
  });

  it("does NOT show the badge when owned is absent (older payload shape)", async () => {
    // Pre-durability payloads have no `owned` field, and every entry they
    // listed necessarily had a live caller — mislabelling those as unowned
    // would be a false warning on every ordinary approval.
    mountWith({ ...BASE });
    await screen.findByText(/rm -rf/i);
    expect(screen.queryByText(/No waiting caller/i)).toBeNull();
  });

  it("high-tier approve confirm says the action will NOT run, not 'cannot be undone'", async () => {
    mountWith({ ...REVERSIBLE_HIGH, owned: false });
    const approveBtn = await screen.findByLabelText(/Approve editText/i);
    fireEvent.click(approveBtn);

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toMatch(/does NOT run the action/i);
    expect(message).not.toMatch(/cannot be undone/i);
  });

  it("keeps the normal 'cannot be undone' confirm for an owned high-tier entry", async () => {
    mountWith({ ...REVERSIBLE_HIGH, owned: true });
    const approveBtn = await screen.findByLabelText(/Approve editText/i);
    fireEvent.click(approveBtn);

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const message = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toMatch(/cannot be undone/i);
  });
});
