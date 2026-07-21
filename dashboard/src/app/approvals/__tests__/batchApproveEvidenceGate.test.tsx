/**
 * Regression: batchDecide() (the "Approve selected" bulk action) never
 * checked the evidence gate that both the single-item Approve button
 * (evidenceLocked, see the card's `disabled` prop) and the `E` keyboard
 * shortcut already enforce — an irreversible action (e.g. a shell command)
 * can't be approved until the reviewer has opened its evidence/diff
 * preview at least once. Bulk approve only gated on a generic
 * window.confirm for high-tier/count>=3 selections and then approved every
 * selected id unconditionally, so a multi-select including an unreviewed
 * irreversible action got approved without the reviewer ever having seen
 * what it does — the same class of gap #1185/#1186/#1191/#1192 closed on
 * other paths, just not this one.
 *
 * Fix: batchDecide excludes evidence-locked ids from an approve batch
 * (mirroring the `E` keyboard shortcut's predicate) and surfaces which ids
 * were skipped instead of silently approving them.
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

// runCommand → domain "shell" → reversibility "irreversible"
// (see dashboard/src/lib/actionClass.ts). Not high-tier, so the bulk
// confirm dialog's tier-based gate wouldn't catch this on its own.
const IRREVERSIBLE_APPROVAL = {
  callId: "bbbbbbbb-2222-2222-2222-222222222222",
  toolName: "runCommand",
  tier: "medium" as const,
  requestedAt: Date.now(),
  summary: "rm -rf /tmp/scratch",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/api/bridge/approvals") && !url.includes("stream")) {
      return jsonResponse([IRREVERSIBLE_APPROVAL]);
    }
    if (url.includes("/api/bridge/cc-permissions")) {
      return jsonResponse(null);
    }
    return jsonResponse({}, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  // Batch confirm dialog would fire if the id weren't filtered out by the
  // evidence gate before reaching the confirm step — default to true so a
  // regression (gate not applied) doesn't get masked by a cancelled confirm.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function selectAndBulkApprove() {
  render(<ApprovalsPage />);

  const checkbox = await screen.findByLabelText(
    /Select runCommand approval bbbbbbbb/i,
  );
  fireEvent.click(checkbox);

  const approveBtn = await screen.findByText(/Approve selected/i);
  fireEvent.click(approveBtn);
}

describe("batchDecide — bulk approve enforces the evidence gate on irreversible actions", () => {
  it("does not POST an approve for an irreversible action whose evidence was never opened", async () => {
    await selectAndBulkApprove();

    // Give any (incorrect) approve fetch a tick to fire before asserting.
    await new Promise((r) => setTimeout(r, 50));
    const approveCall = fetchMock.mock.calls.find(
      (c) =>
        (c[1] as RequestInit | undefined)?.method === "POST" &&
        (c[0] as string).includes(`/approve/${IRREVERSIBLE_APPROVAL.callId}`),
    );
    expect(approveCall).toBeUndefined();
  });

  it("surfaces that the item was locked instead of silently doing nothing", async () => {
    await selectAndBulkApprove();

    await waitFor(() => {
      expect(
        screen.queryByText(/Approve locked for 1 item/i),
      ).not.toBeNull();
    });
  });
});
