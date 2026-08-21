/**
 * ADR-0020 Phase A — an `approval_decision` row names the human who decided.
 *
 * `recipeOrchestration.ts` has carried the note "the approving human is not
 * known here, and cannot be until the approval path carries an identity" since
 * ADR-0017. These tests drive the approval route end to end with a REAL signed
 * session cookie and a real resolver, and assert on the audit row.
 *
 * The negative cases carry the weight. An `actor` that appears when nobody was
 * identified is not a smaller version of correct attribution — it is a claim
 * about a person, written into an audit log, on no evidence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import type { ApprovalQueue } from "../approvalQueue.js";
import { createApproverResolver } from "../identity/approverFromSession.js";
import { signSession } from "../identity/dashboardSession.js";
import type { Roster } from "../identity/roster.js";

const SECRET = "f".repeat(48);

const ada: Roster["members"][number] = {
  id: "ada",
  displayName: "Ada L",
  kind: "human",
  roles: ["approver"],
  active: true,
};

const roster: Roster = {
  members: [ada],
  implicit: false,
  unreadable: false,
  dropped: [],
};

function makeQueue(): ApprovalQueue {
  return {
    validateToken: () => true,
    approve: () => true,
    reject: () => true,
    getRecentDecision: () => undefined,
    list: () => [],
    enqueue: () => Promise.resolve({ callId: "test", timedOut: false }),
    cancelPending: () => {},
    getPendingList: () => [],
    on: () => {},
    off: () => {},
    isPending: () => false,
    getFailureCount: () => 0,
  } as unknown as ApprovalQueue;
}

const resolveApprover = createApproverResolver({ rosterFor: () => roster });

beforeEach(() => {
  process.env.DASHBOARD_SESSION_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.DASHBOARD_SESSION_SECRET;
});

async function decide(
  action: "approve" | "reject",
  sessionCookie?: string,
): Promise<Record<string, unknown>> {
  const onDecision = vi.fn();
  await routeApprovalRequest(
    { method: "POST", path: `/${action}/call-1`, body: {}, sessionCookie },
    { queue: makeQueue(), workspace: "/tmp", onDecision, resolveApprover },
  );
  expect(onDecision).toHaveBeenCalledTimes(1);
  return onDecision.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("approval_decision actor attribution", () => {
  it("names the approver from a verified v2 session", async () => {
    const meta = await decide(
      "approve",
      await signSession({ memberId: "ada" }),
    );
    expect(meta.decision).toBe("allow");
    expect(meta.actor).toEqual({
      id: "ada",
      kind: "human",
      displayName: "Ada L",
    });
  });

  it("names the REJECTER too — a refusal is attributed on the same terms", async () => {
    const meta = await decide("reject", await signSession({ memberId: "ada" }));
    expect(meta.decision).toBe("deny");
    expect(meta.actor).toEqual({
      id: "ada",
      kind: "human",
      displayName: "Ada L",
    });
  });

  it("records NO actor key for a v1 session", async () => {
    const meta = await decide("approve", await signSession());
    // Absent, not undefined-valued: an `in` check downstream must read this as
    // "nobody recorded it", never as a subject that happens to be blank.
    expect("actor" in meta).toBe(false);
  });

  it("records NO actor for a forged cookie", async () => {
    const meta = await decide("approve", "v2.root.99999999999999.notasig");
    expect("actor" in meta).toBe(false);
  });

  it("records NO actor when no cookie is forwarded (the phone path)", async () => {
    const meta = await decide("approve", undefined);
    expect("actor" in meta).toBe(false);
  });

  it("still decides, unattributed, when no resolver is wired at all", async () => {
    // The default deployment: the bridge has no DASHBOARD_SESSION_SECRET, so
    // `resolveApprover` is never assigned. The approval must still work.
    const onDecision = vi.fn();
    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approve/call-1",
        body: {},
        sessionCookie: await signSession({ memberId: "ada" }),
      },
      { queue: makeQueue(), workspace: "/tmp", onDecision },
    );
    expect(result.status).toBe(200);
    const meta = onDecision.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("actor" in meta).toBe(false);
  });

  it("does not fail the approval when attribution throws", async () => {
    const onDecision = vi.fn();
    const result = await routeApprovalRequest(
      { method: "POST", path: "/approve/call-1", body: {}, sessionCookie: "x" },
      {
        queue: makeQueue(),
        workspace: "/tmp",
        onDecision,
        resolveApprover: () => Promise.reject(new Error("boom")),
      },
    ).catch((e: unknown) => e);
    // A decision the human already made must not be undone by the bookkeeping
    // that records who made it.
    expect(result).toMatchObject({ status: 200 });
  });
});
