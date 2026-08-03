import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalPersistence,
  resolveApprovalLogDir,
} from "../approvalPersistence.js";
import type { PendingApproval } from "../approvalQueue.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-approval-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pending(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    callId: "c1",
    toolName: "gitPush",
    params: { remote: "origin" },
    tier: "high",
    requestedAt: 1000,
    expiresAt: 5000,
    owned: true,
    ...over,
  };
}

describe("resolveApprovalLogDir", () => {
  it("honors PATCHWORK_HOME override", () => {
    const prior = process.env.PATCHWORK_HOME;
    const customHome = path.join(os.tmpdir(), "pw-custom-home");
    process.env.PATCHWORK_HOME = customHome;
    try {
      expect(resolveApprovalLogDir()).toBe(customHome);
    } finally {
      if (prior === undefined) delete process.env.PATCHWORK_HOME;
      else process.env.PATCHWORK_HOME = prior;
    }
  });

  it("an explicit override wins over PATCHWORK_HOME", () => {
    expect(resolveApprovalLogDir("/explicit")).toBe("/explicit");
  });
});

describe("ApprovalPersistence", () => {
  it("writes a request event and reads it back as unresolved", () => {
    const log = new ApprovalPersistence({ dir });
    log.recordRequest(pending());
    const unresolved = log.loadUnresolvedRequests();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      kind: "request",
      callId: "c1",
      toolName: "gitPush",
      tier: "high",
    });
  });

  it("a request with a matching decision is not unresolved", () => {
    const log = new ApprovalPersistence({ dir });
    log.recordRequest(pending());
    log.recordDecision("c1", "approved", 2000);
    expect(log.loadUnresolvedRequests()).toHaveLength(0);
  });

  it("only unresolved requests are returned when some are decided", () => {
    const log = new ApprovalPersistence({ dir });
    log.recordRequest(pending({ callId: "c1" }));
    log.recordRequest(pending({ callId: "c2" }));
    log.recordDecision("c1", "rejected", 2000);
    const unresolved = log.loadUnresolvedRequests();
    expect(unresolved.map((r) => r.callId)).toEqual(["c2"]);
  });

  it("returns an empty list when no log file exists yet", () => {
    const log = new ApprovalPersistence({ dir });
    expect(log.loadUnresolvedRequests()).toEqual([]);
  });

  it("skips a torn/malformed trailing line instead of aborting the whole replay", () => {
    const log = new ApprovalPersistence({ dir });
    log.recordRequest(pending({ callId: "c1" }));
    log.recordRequest(pending({ callId: "c2" }));
    // Simulate a process killed mid-appendFileSync: append a partial JSON line.
    const file = path.join(dir, "approval_log.jsonl");
    const existing = readFileSync(file, "utf8");
    const truncated = `${existing}{"kind":"request","callId":"c3","toolNam`;
    writeFileSync(file, truncated, "utf8");
    const unresolved = log.loadUnresolvedRequests();
    expect(unresolved.map((r) => r.callId).sort()).toEqual(["c1", "c2"]);
  });

  it("truncates oversized params rather than dropping the request", () => {
    const log = new ApprovalPersistence({ dir });
    const huge = { blob: "x".repeat(20_000) };
    log.recordRequest(pending({ params: huge }));
    const unresolved = log.loadUnresolvedRequests();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.params).toMatchObject({ truncated: true });
  });

  it("never throws when the directory cannot be created (fail-soft write)", () => {
    // A file path used as a "directory" can't be mkdir'd into — recordRequest
    // must swallow the error rather than crash a live approval flow.
    const blockedDir = path.join(dir, "not-a-dir");
    writeFileSync(blockedDir, "x");
    const log = new ApprovalPersistence({ dir: blockedDir });
    expect(() => log.recordRequest(pending())).not.toThrow();
    expect(log.loadUnresolvedRequests()).toEqual([]);
  });
});
