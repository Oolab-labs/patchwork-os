/**
 * Unit tests for buildSessionDetail — the GET /sessions/:id payload builder.
 * Audit 2026-06-08 HIGH (server-1).
 */
import { describe, expect, it } from "vitest";
import {
  buildSessionDetail,
  type SessionDetailActivityLog,
  type SessionDetailSession,
} from "../sessionDetail.js";

const FULL = "abcd1234-5678-90ab-cdef-1234567890ab";
const SHORT = FULL.slice(0, 8); // "abcd1234"

function sessions(): SessionDetailSession[] {
  return [
    {
      id: FULL,
      connectedAt: Date.parse("2026-06-09T08:00:00.000Z"),
      openedFiles: new Set(["a.ts", "b.ts"]),
      remoteAddr: "10.0.0.5",
    },
  ];
}

function activityLog(): SessionDetailActivityLog {
  return {
    querySessionLifecycle: (sid) =>
      sid === FULL
        ? [
            { event: "claude_connected" },
            { event: "approval_decision" },
            { event: "grace_started" },
          ]
        : [],
    querySessionTools: (sid) =>
      sid === FULL ? [{ tool: "getGitStatus" }, { tool: "gitCommit" }] : [],
  };
}

describe("buildSessionDetail", () => {
  it("resolves the 8-char prefix to the active session and slices its activity", () => {
    const approvals = [{ sessionId: FULL }, { sessionId: "ffff0000-other" }];
    const r = buildSessionDetail(SHORT, sessions(), activityLog(), approvals);

    expect(r.summary).not.toBeNull();
    expect(r.summary?.id).toBe(SHORT);
    expect(r.summary?.openedFileCount).toBe(2);
    expect(r.summary?.connectedAt).toBe("2026-06-09T08:00:00.000Z");
    expect(r.summary?.remoteAddr).toBe("10.0.0.5");
    // Only the approval whose sessionId shares the prefix counts.
    expect(r.summary?.pendingApprovals).toBe(1);
    expect(r.approvals).toHaveLength(1);

    expect(r.lifecycle).toHaveLength(3);
    expect(r.tools).toHaveLength(2);
    // decisions is the approval_decision subset of lifecycle.
    expect(r.decisions).toHaveLength(1);
    expect((r.decisions[0] as { event: string }).event).toBe(
      "approval_decision",
    );
  });

  it("also resolves a full session id", () => {
    const r = buildSessionDetail(FULL, sessions(), activityLog(), []);
    expect(r.summary?.id).toBe(SHORT);
    expect(r.tools).toHaveLength(2);
  });

  it("returns summary:null (→ route 404) for an unknown session", () => {
    const r = buildSessionDetail("deadbeef", sessions(), activityLog(), []);
    expect(r.summary).toBeNull();
    expect(r.lifecycle).toEqual([]);
    expect(r.tools).toEqual([]);
    expect(r.decisions).toEqual([]);
    expect(r.approvals).toEqual([]);
  });

  it("omits remoteAddr when the session has none", () => {
    const s: SessionDetailSession[] = [
      {
        id: FULL,
        connectedAt: Date.now(),
        openedFiles: new Set(),
      },
    ];
    const r = buildSessionDetail(SHORT, s, activityLog(), []);
    expect(r.summary).not.toBeNull();
    expect("remoteAddr" in (r.summary as object)).toBe(false);
  });

  it("tolerates an absent activity log (summary still returned)", () => {
    const r = buildSessionDetail(SHORT, sessions(), undefined, [
      { sessionId: FULL },
    ]);
    expect(r.summary?.id).toBe(SHORT);
    expect(r.summary?.pendingApprovals).toBe(1);
    expect(r.lifecycle).toEqual([]);
    expect(r.tools).toEqual([]);
    expect(r.decisions).toEqual([]);
  });
});
