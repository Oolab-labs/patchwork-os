import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMetrics } from "../activationMetrics.js";
import { routeApprovalRequest } from "../approvalHttp.js";
import { ApprovalQueue } from "../approvalQueue.js";

function emptyRules() {
  return () => ({ allow: [], ask: [], deny: [] });
}

describe("routeApprovalRequest activation metrics", () => {
  let tempDir = "";
  let previousPatchworkHome: string | undefined;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-activation-"));
    previousPatchworkHome = process.env.PATCHWORK_HOME;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.PATCHWORK_HOME = path.join(tempDir, "patchwork");
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, "claude");
  });

  afterEach(() => {
    if (previousPatchworkHome === undefined) {
      delete process.env.PATCHWORK_HOME;
    } else {
      process.env.PATCHWORK_HOME = previousPatchworkHome;
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records prompted and completed counts for approved approvals", async () => {
    const queue = new ApprovalQueue();
    const pending = routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "gitPush", summary: "Push to origin/main" },
      },
      {
        queue,
        workspace: "/tmp/workspace",
        ccLoader: emptyRules(),
        approvalGate: "all",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    let metrics = loadMetrics();
    expect(metrics.approvalsPrompted).toBe(1);
    expect(metrics.approvalsCompleted).toBe(0);

    const [entry] = queue.list();
    expect(entry).toBeDefined();
    queue.approve(entry!.callId);

    const result = await pending;
    expect(result.body).toMatchObject({
      decision: "allow",
      reason: "approved",
    });

    metrics = loadMetrics();
    expect(metrics.approvalsPrompted).toBe(1);
    expect(metrics.approvalsCompleted).toBe(1);
  });

  it("does not increment completed count for expired approvals", async () => {
    const queue = new ApprovalQueue({ ttlMs: 10 });
    const result = await routeApprovalRequest(
      {
        method: "POST",
        path: "/approvals",
        body: { toolName: "gitPush", summary: "Push to origin/main" },
      },
      {
        queue,
        workspace: "/tmp/workspace",
        ccLoader: emptyRules(),
        approvalGate: "all",
      },
    );

    expect(result.body).toMatchObject({ decision: "deny", reason: "expired" });

    const metrics = loadMetrics();
    expect(metrics.approvalsPrompted).toBe(1);
    expect(metrics.approvalsCompleted).toBe(0);
  });
});
