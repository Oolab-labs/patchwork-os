import { describe, expect, it } from "vitest";
import type { ActivityLog } from "../activityLog.js";
import type { LifecycleEntry } from "../activityTypes.js";
import type { PermissionRules } from "../ccPermissions.js";
import { computeDecisionReplay } from "../decisionReplay.js";

/**
 * Build a minimal ActivityLog stub that only implements queryApprovalDecisions
 * (the single method computeDecisionReplay depends on).
 */
function fakeLog(entries: LifecycleEntry[]): ActivityLog {
  return {
    queryApprovalDecisions: () => entries,
  } as unknown as ActivityLog;
}

let nextId = 1;
function row(
  toolName: string,
  decision: string,
  specifier?: string,
): LifecycleEntry {
  return {
    id: nextId++,
    timestamp: new Date(2026, 0, 1, 0, 0, nextId).toISOString(),
    event: "approval_decision",
    metadata: {
      toolName,
      decision,
      ...(specifier !== undefined && { specifier }),
    },
  };
}

describe("computeDecisionReplay — change bucketing", () => {
  it("buckets ask→deny and ask→allow correctly and counts sum to changedCount", () => {
    // Current policy: deny ToolDeny, allow ToolAllow.
    const rules: PermissionRules = {
      allow: ["ToolAllow"],
      ask: [],
      deny: ["ToolDeny"],
    };

    const entries = [
      // originally "ask", current policy denies it → now_denied
      row("ToolDeny", "ask"),
      // originally "ask", current policy allows it → now_allowed
      row("ToolAllow", "ask"),
    ];

    const result = computeDecisionReplay(fakeLog(entries), {
      workspace: "/ws",
      loadRulesFn: () => rules,
    });

    const askToDeny = result.rows.find((r) => r.toolName === "ToolDeny");
    const askToAllow = result.rows.find((r) => r.toolName === "ToolAllow");

    expect(askToDeny?.replayDecision).toBe("deny");
    expect(askToDeny?.unchanged).toBe(false);
    expect(askToDeny?.changeKind).toBe("now_denied");

    expect(askToAllow?.replayDecision).toBe("allow");
    expect(askToAllow?.unchanged).toBe(false);
    expect(askToAllow?.changeKind).toBe("now_allowed");

    // Both rows changed.
    expect(result.changedCount).toBe(2);
    expect(result.nowDeniedCount).toBe(1);
    expect(result.nowAllowedCount).toBe(1);
    expect(result.nowAskedCount).toBe(0);

    // Buckets must sum exactly to changedCount — the core invariant.
    expect(
      result.nowAllowedCount + result.nowDeniedCount + result.nowAskedCount,
    ).toBe(result.changedCount);
  });

  it("ask→none (no current rule matches) is now_denied and counted, not an orphan", () => {
    // Empty policy → every tool evaluates to "none".
    const rules: PermissionRules = { allow: [], ask: [], deny: [] };
    const entries = [row("SomeTool", "ask")];

    const result = computeDecisionReplay(fakeLog(entries), {
      workspace: "/ws",
      loadRulesFn: () => rules,
    });

    const r = result.rows[0];
    expect(r?.replayDecision).toBe("none");
    // ask → none is a real flip (previously gated, now effectively unmatched).
    expect(r?.unchanged).toBe(false);
    expect(r?.changeKind).toBe("now_denied");

    expect(result.changedCount).toBe(1);
    expect(result.nowDeniedCount).toBe(1);
    expect(
      result.nowAllowedCount + result.nowDeniedCount + result.nowAskedCount,
    ).toBe(result.changedCount);
  });

  it("exposes a nowAskedCount field and counts *→ask transitions", () => {
    const rules: PermissionRules = {
      allow: [],
      ask: ["ToolAsk"],
      deny: [],
    };
    const entries = [
      // originally allow, current policy asks → now_asked
      row("ToolAsk", "allow"),
    ];

    const result = computeDecisionReplay(fakeLog(entries), {
      workspace: "/ws",
      loadRulesFn: () => rules,
    });

    expect(result.nowAskedCount).toBe(1);
    expect(result.rows[0]?.changeKind).toBe("now_asked");
    expect(result.changedCount).toBe(1);
    expect(
      result.nowAllowedCount + result.nowDeniedCount + result.nowAskedCount,
    ).toBe(result.changedCount);
  });

  it("every changed row maps to exactly one bucket across a mixed fixture", () => {
    const rules: PermissionRules = {
      allow: ["ToolAllow"],
      ask: ["ToolAsk"],
      deny: ["ToolDeny"],
    };
    const entries = [
      row("ToolDeny", "ask"), // ask → deny (now_denied)
      row("ToolAllow", "ask"), // ask → allow (now_allowed)
      row("ToolAsk", "allow"), // allow → ask (now_asked)
      row("ToolDeny", "allow"), // allow → deny (now_denied)
      row("Unmatched", "ask"), // ask → none (now_denied)
      row("ToolAllow", "allow"), // unchanged
      row("ToolDeny", "deny"), // unchanged
    ];

    const result = computeDecisionReplay(fakeLog(entries), {
      workspace: "/ws",
      loadRulesFn: () => rules,
    });

    // 5 changed, 2 unchanged.
    expect(result.changedCount).toBe(5);
    expect(result.nowAllowedCount).toBe(1);
    expect(result.nowAskedCount).toBe(1);
    expect(result.nowDeniedCount).toBe(3);

    // Invariant: buckets sum to changedCount, and every changed row carries a kind.
    expect(
      result.nowAllowedCount + result.nowDeniedCount + result.nowAskedCount,
    ).toBe(result.changedCount);
    for (const r of result.rows) {
      if (r.unchanged) {
        expect(r.changeKind).toBeUndefined();
      } else {
        expect(r.changeKind).toBeDefined();
      }
    }
  });
});
