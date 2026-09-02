/**
 * ADR-0020 — the approver reaches a DURABLE governance ledger, not just the
 * activity log.
 *
 * `approvalHttp-actor.test.ts` already proves the identity is resolved: a
 * verified v2 session names the human on the `approval_decision` audit hook.
 * What it cannot see is where that name ends up. The hook's only production
 * sink is `activityLog`, which persists best-effort and ROTATES — it halves
 * itself when it grows — so the one record of who approved a gated action was
 * the one record allowed to discard its oldest rows.
 *
 * Meanwhile `approval_log.jsonl` (ADR-0018), the durable event source, had no
 * field for an actor at all: 118 decision rows on the reference deployment,
 * none of which could name a person.
 *
 * These tests drive the real queue and the real HTTP route against a real log
 * directory, and assert on the FILE. A test that asserted on the `onDecision`
 * mock would pass today and prove nothing about durability.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeApprovalRequest } from "../approvalHttp.js";
import { ApprovalQueue } from "../approvalQueue.js";
import { createApproverResolver } from "../identity/approverFromSession.js";
import { signSession } from "../identity/dashboardSession.js";
import type { Roster } from "../identity/roster.js";

const SECRET = "f".repeat(48);

const roster: Roster = {
  members: [
    {
      id: "ada",
      displayName: "Ada L",
      kind: "human",
      roles: ["approver"],
      active: true,
    },
  ],
  implicit: false,
  unreadable: false,
  dropped: [],
};

const resolveApprover = createApproverResolver({ rosterFor: () => roster });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-approval-attrib-"));
  process.env.DASHBOARD_SESSION_SECRET = SECRET;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DASHBOARD_SESSION_SECRET;
});

function logRows(): Array<Record<string, unknown>> {
  return (
    readFileSync(path.join(dir, "approval_log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      // ADR-0027 marker rows (`chain-start`, `rotation`) live in the same
      // file and carry `kind` and no data fields; skipped the way every
      // production loader skips them.
      .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation")
  );
}

async function decide(
  action: "approve" | "reject",
  sessionCookie?: string,
): Promise<{ callId: string; rows: Array<Record<string, unknown>> }> {
  const queue = new ApprovalQueue({ persistDir: dir });
  const { callId } = queue.request({
    toolName: "gitPush",
    params: { remote: "origin" },
    tier: "high",
  });
  await routeApprovalRequest(
    { method: "POST", path: `/${action}/${callId}`, body: {}, sessionCookie },
    { queue, workspace: "/tmp", resolveApprover },
  );
  return { callId, rows: logRows() };
}

describe("durable approver attribution", () => {
  it("records who approved, in the durable log, from a verified v2 session", async () => {
    const { callId, rows } = await decide(
      "approve",
      await signSession({ memberId: "ada" }),
    );

    const attribution = rows.filter((r) => r.kind === "attribution");
    expect(attribution).toHaveLength(1);
    expect(attribution[0]).toMatchObject({
      kind: "attribution",
      callId,
      actor: { id: "ada", kind: "human", displayName: "Ada L" },
    });
  });

  it("records who rejected, on the same terms", async () => {
    const { callId, rows } = await decide(
      "reject",
      await signSession({ memberId: "ada" }),
    );
    expect(rows.filter((r) => r.kind === "attribution")).toMatchObject([
      { callId, actor: { id: "ada", kind: "human" } },
    ]);
  });

  /**
   * The negative cases carry the weight, exactly as in the sibling actor
   * tests. An attribution row that appears when nobody was identified is not
   * a weaker form of attribution — it is a claim about a person written into
   * a governance ledger on no evidence. Absence must stay absence.
   */
  it("writes NO attribution row for an unattributed v1 session", async () => {
    const { rows } = await decide("approve", await signSession());
    expect(rows.filter((r) => r.kind === "attribution")).toHaveLength(0);
    expect(rows.filter((r) => r.kind === "decision")).toHaveLength(1);
  });

  it("writes NO attribution row when there is no session at all", async () => {
    const { rows } = await decide("approve");
    expect(rows.filter((r) => r.kind === "attribution")).toHaveLength(0);
  });

  /**
   * The decision must land first and must not depend on attribution. An
   * approval that a failing identity lookup could roll back would make the
   * audit trail able to change the outcome it describes.
   */
  it("still records the decision when the resolver throws", async () => {
    const queue = new ApprovalQueue({ persistDir: dir });
    const { callId } = queue.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    const res = await routeApprovalRequest(
      { method: "POST", path: `/approve/${callId}`, body: {} },
      {
        queue,
        workspace: "/tmp",
        resolveApprover: () => Promise.reject(new Error("boom")),
      },
    );
    expect(res.status).toBe(200);
    const rows = logRows();
    expect(rows.filter((r) => r.kind === "decision")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "attribution")).toHaveLength(0);
  });

  /**
   * The 118 rows already on the reference deployment predate this event kind.
   * The restore path must treat a log containing attribution rows exactly as
   * it treated one without them — an unknown kind is neither a request nor a
   * decision, so it can neither restore a phantom nor mask a pending one.
   */
  it("an attribution row does not disturb restart restore", async () => {
    const q1 = new ApprovalQueue({ persistDir: dir });
    const decided = q1.request({
      toolName: "gitPush",
      params: {},
      tier: "high",
    });
    const stillPending = q1.request({
      toolName: "gitPush",
      params: { other: true },
      tier: "high",
    });
    await routeApprovalRequest(
      {
        method: "POST",
        path: `/approve/${decided.callId}`,
        body: {},
        sessionCookie: await signSession({ memberId: "ada" }),
      },
      { queue: q1, workspace: "/tmp", resolveApprover },
    );
    expect(logRows().filter((r) => r.kind === "attribution")).toHaveLength(1);

    const q2 = new ApprovalQueue({ persistDir: dir });
    const restored = q2.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.callId).toBe(stillPending.callId);
  });
});
