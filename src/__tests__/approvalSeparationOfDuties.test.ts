/**
 * Separation of duties on the approval route (ADR-0020).
 *
 * Two refusals, both checked BEFORE `queue.approve()` runs, so a refused
 * approval never takes effect:
 *
 *   1. Self-approval. A request carries `preparedBy` when a named member
 *      started the run from the dashboard. That same member cannot approve it.
 *   2. Unnamed approval, when the bridge requires a named approver (governed
 *      profile AND at least one member with a login). A shared-password (v1)
 *      session, no session, and the phone token path all name nobody, and
 *      are refused.
 *
 * Rejecting stays open to everyone: refusing an action is never the risky
 * direction, and blocking it would leave an operator unable to stop a run.
 *
 * Everything else must behave exactly as before. The last block pins that.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import { ApprovalQueue } from "../approvalQueue.js";
import { createApproverResolver } from "../identity/approverFromSession.js";
import { signSession } from "../identity/dashboardSession.js";
import { memberLoginsExist } from "../identity/namedApproval.js";
import type { Roster } from "../identity/roster.js";

const SECRET = "f".repeat(48);
const member = (id: string): Roster["members"][number] => ({
  id,
  displayName: id.toUpperCase(),
  kind: "human",
  roles: ["approver", "operator"],
  active: true,
});
const roster: Roster = {
  members: [member("ada"), member("bo")],
  implicit: false,
  unreadable: false,
  dropped: [],
};
const resolveApprover = createApproverResolver({ rosterFor: () => roster });

let dir: string;
let queue: ApprovalQueue;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-approval-sod-"));
  process.env.DASHBOARD_SESSION_SECRET = SECRET;
  queue = new ApprovalQueue({ persistDir: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DASHBOARD_SESSION_SECRET;
});

function enqueue(preparedBy?: string): string {
  const { callId } = queue.request({
    toolName: "gitPush",
    params: { remote: "origin" },
    tier: "high",
    ...(preparedBy !== undefined && { preparedBy }),
  });
  return callId;
}

async function approve(
  callId: string,
  opts: {
    sessionCookie?: string;
    approvalToken?: string;
    requireNamedApprover?: boolean;
  } = {},
) {
  return routeApprovalRequest(
    {
      method: "POST",
      path: `/approve/${callId}`,
      body: {},
      ...(opts.sessionCookie !== undefined && {
        sessionCookie: opts.sessionCookie,
      }),
      ...(opts.approvalToken !== undefined && {
        approvalToken: opts.approvalToken,
      }),
    },
    {
      queue,
      workspace: "/tmp",
      resolveApprover,
      ...(opts.requireNamedApprover !== undefined && {
        requireNamedApprover: opts.requireNamedApprover,
      }),
    },
  );
}

const pending = (callId: string) =>
  queue.list().some((e) => e.callId === callId);

describe("self-approval", () => {
  it("refuses the member who started the run, and the approval does not take effect", async () => {
    const callId = enqueue("ada");
    const res = await approve(callId, {
      sessionCookie: await signSession({ memberId: "ada" }),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "self_approval" });
    expect(pending(callId)).toBe(true);
  });

  it("lets a different named member approve it", async () => {
    const callId = enqueue("ada");
    const res = await approve(callId, {
      sessionCookie: await signSession({ memberId: "bo" }),
    });
    expect(res.status).toBe(200);
    expect(pending(callId)).toBe(false);
  });

  it("still refuses self-approval after a restart restores the request", async () => {
    const callId = enqueue("ada");
    queue = new ApprovalQueue({ persistDir: dir });
    expect(queue.list().find((e) => e.callId === callId)?.preparedBy).toBe(
      "ada",
    );
    const res = await approve(callId, {
      sessionCookie: await signSession({ memberId: "ada" }),
    });
    expect(res.status).toBe(403);
  });

  it("writes preparedBy to the durable request row", () => {
    const callId = enqueue("ada");
    const rows = readFileSync(path.join(dir, "approval_log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: "request", callId, preparedBy: "ada" }),
    );
  });

  it("does not change the approved-action identity", () => {
    const a = queue.request({
      toolName: "t",
      params: { x: 1 },
      tier: "high",
      correlationId: "run-a",
    });
    const b = new ApprovalQueue({
      persistDir: mkdtempSync(path.join(os.tmpdir(), "pw-approval-sod-b-")),
    }).request({
      toolName: "t",
      params: { x: 1 },
      tier: "high",
      correlationId: "run-a",
      preparedBy: "ada",
    });
    expect(b.approvedActionIdentity).toBe(a.approvedActionIdentity);
  });
});

describe("named approval required", () => {
  it("refuses a shared-password (v1) session", async () => {
    const callId = enqueue();
    const res = await approve(callId, {
      sessionCookie: await signSession(),
      requireNamedApprover: true,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "named_approver_required" });
    expect(pending(callId)).toBe(true);
  });

  it("refuses no session at all, and the phone token path", async () => {
    const callId = enqueue();
    expect((await approve(callId, { requireNamedApprover: true })).status).toBe(
      403,
    );
    // A VALID single-use phone token: the refusal must come from the named
    // rule, not from a bad token.
    const phoneCall = queue.request(
      { toolName: "gitPush", params: { remote: "phone" }, tier: "high" },
      { withToken: true },
    );
    expect(phoneCall.approvalToken).toBeTruthy();
    const phone = await approve(phoneCall.callId, {
      approvalToken: phoneCall.approvalToken as string,
      requireNamedApprover: true,
    });
    expect(phone.status).toBe(403);
    expect(phone.body).toMatchObject({ error: "named_approver_required" });
    expect(pending(callId)).toBe(true);
    expect(pending(phoneCall.callId)).toBe(true);
  });

  it("accepts a named member", async () => {
    const callId = enqueue();
    const res = await approve(callId, {
      sessionCookie: await signSession({ memberId: "bo" }),
      requireNamedApprover: true,
    });
    expect(res.status).toBe(200);
  });

  it("never blocks a rejection", async () => {
    const callId = enqueue("ada");
    const res = await routeApprovalRequest(
      {
        method: "POST",
        path: `/reject/${callId}`,
        body: {},
        sessionCookie: await signSession({ memberId: "ada" }),
      },
      { queue, workspace: "/tmp", resolveApprover, requireNamedApprover: true },
    );
    expect(res.status).toBe(200);
    expect(pending(callId)).toBe(false);
  });
});

describe("unchanged when neither rule applies", () => {
  it("an unnamed approval of a request with no preparer still works by default", async () => {
    const callId = enqueue();
    expect(
      (await approve(callId, { sessionCookie: await signSession() })).status,
    ).toBe(200);
  });

  it("a request with no preparer can be approved by anyone named", async () => {
    const callId = enqueue();
    expect(
      (
        await approve(callId, {
          sessionCookie: await signSession({ memberId: "ada" }),
        })
      ).status,
    ).toBe(200);
  });
});

describe("memberLoginsExist", () => {
  const creds = (ids: string[]) => ({
    credentialFor: (id: string) => (ids.includes(id) ? "rec" : undefined),
  });

  it("is true only for a real roster with an active human who has a login", () => {
    expect(memberLoginsExist(roster, creds(["ada"]))).toBe(true);
    expect(memberLoginsExist(roster, creds([]))).toBe(false);
    expect(
      memberLoginsExist({ ...roster, implicit: true }, creds(["ada"])),
    ).toBe(false);
    expect(
      memberLoginsExist(
        { ...roster, members: [{ ...member("ada"), active: false }] },
        creds(["ada"]),
      ),
    ).toBe(false);
    expect(
      memberLoginsExist(
        { ...roster, members: [{ ...member("ada"), kind: "worker" }] },
        creds(["ada"]),
      ),
    ).toBe(false);
  });
});
