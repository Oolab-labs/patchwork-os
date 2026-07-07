/**
 * computeApprovalInsights had zero test coverage despite aggregating
 * approval-decision history into the per-tool heuristics the dashboard
 * renders (approvalRate, heuristicLabel, severity, trusted/rejected counts).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { ActivityLog } from "../activityLog.js";
import { computeApprovalInsights } from "../approvalInsights.js";

let log: ActivityLog;

beforeEach(() => {
  log = new ActivityLog();
});

describe("computeApprovalInsights", () => {
  it("returns an empty result with zero counts when there are no decisions", () => {
    const out = computeApprovalInsights(log);
    expect(out.tools).toEqual([]);
    expect(out.totalDecisions).toBe(0);
    expect(out.rejectedToolCount).toBe(0);
    expect(out.trustedToolCount).toBe(0);
    expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("aggregates allow/deny/reject decisions per tool", () => {
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "deny",
    });
    log.recordEvent("approval_decision", {
      toolName: "gitPush",
      decision: "reject",
    });

    const out = computeApprovalInsights(log);
    expect(out.totalDecisions).toBe(4);
    const bash = out.tools.find((t) => t.toolName === "Bash");
    expect(bash).toMatchObject({ approvals: 2, rejections: 1 });
    expect(bash?.approvalRate).toBeCloseTo(2 / 3);
    const gitPush = out.tools.find((t) => t.toolName === "gitPush");
    expect(gitPush).toMatchObject({ approvals: 0, rejections: 1 });
  });

  it("buckets decisions with no toolName under '(unknown)'", () => {
    log.recordEvent("approval_decision", { decision: "allow" });
    const out = computeApprovalInsights(log);
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]?.toolName).toBe("(unknown)");
  });

  it("ignores a decision value that isn't allow/deny/reject (counts toward totals only)", () => {
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "pending",
    });
    const out = computeApprovalInsights(log);
    expect(out.tools[0]).toMatchObject({ approvals: 0, rejections: 0 });
    expect(out.tools[0]?.approvalRate).toBeNull();
    expect(out.tools[0]?.heuristicLabel).toBe("No decisions yet");
  });

  it("records first/last decision timestamps sorted oldest-to-newest", () => {
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
    });
    const out = computeApprovalInsights(log);
    const bash = out.tools[0];
    expect(bash?.firstDecisionAt).not.toBeNull();
    expect(bash?.lastDecisionAt).not.toBeNull();
    expect(new Date(bash!.firstDecisionAt!).getTime()).toBeLessThanOrEqual(
      new Date(bash!.lastDecisionAt!).getTime(),
    );
  });

  it("marks a tool trusted at >=3 approvals with zero rejections", () => {
    for (let i = 0; i < 3; i++) {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
    }
    const out = computeApprovalInsights(log);
    expect(out.trustedToolCount).toBe(1);
    // Severity's "low" threshold (>=5 approvals) is independently higher than
    // trustedToolCount's (>=3) — at exactly 3 approvals severity is still
    // "medium" even though the tool already counts as trusted.
    expect(out.tools[0]?.severity).toBe("medium");
  });

  it("marks severity low once approvals reach the >=5 threshold with zero rejections", () => {
    for (let i = 0; i < 5; i++) {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
    }
    const out = computeApprovalInsights(log);
    expect(out.tools[0]?.severity).toBe("low");
  });

  it("does not mark a tool trusted below the 3-approval threshold", () => {
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
    });
    const out = computeApprovalInsights(log);
    expect(out.trustedToolCount).toBe(0);
    expect(out.tools[0]?.severity).toBe("medium");
  });

  it("marks severity high and counts rejectedToolCount for any tool with a rejection, regardless of approval count", () => {
    for (let i = 0; i < 5; i++) {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
    }
    log.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "deny",
    });
    const out = computeApprovalInsights(log);
    expect(out.rejectedToolCount).toBe(1);
    expect(out.tools[0]?.severity).toBe("high");
  });

  it("sorts tools by total decisions descending, then toolName ascending on ties", () => {
    log.recordEvent("approval_decision", {
      toolName: "zzz",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "aaa",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "busy",
      decision: "allow",
    });
    log.recordEvent("approval_decision", {
      toolName: "busy",
      decision: "allow",
    });
    const out = computeApprovalInsights(log);
    expect(out.tools.map((t) => t.toolName)).toEqual(["busy", "aaa", "zzz"]);
  });

  describe("heuristicLabel wording", () => {
    it("labels a single approval distinctly from multiple", () => {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe("Approved once");
    });

    it("labels 2-4 approvals as a plain count", () => {
      for (let i = 0; i < 3; i++) {
        log.recordEvent("approval_decision", {
          toolName: "Bash",
          decision: "allow",
        });
      }
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe("Approved 3 times");
    });

    it("labels 5+ approvals as an established pattern", () => {
      for (let i = 0; i < 5; i++) {
        log.recordEvent("approval_decision", {
          toolName: "Bash",
          decision: "allow",
        });
      }
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe(
        "Approved 5 times — pattern established",
      );
    });

    it("labels a single rejection distinctly from multiple", () => {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "deny",
      });
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe(
        "Rejected once — you blocked this tool",
      );
    });

    it("labels multiple rejections with zero approvals as consistently blocked", () => {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "deny",
      });
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "deny",
      });
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe(
        "Rejected 2 times — you consistently block this tool",
      );
    });

    it("labels a >=80% approval rate with mixed history as high-confidence", () => {
      for (let i = 0; i < 4; i++) {
        log.recordEvent("approval_decision", {
          toolName: "Bash",
          decision: "allow",
        });
      }
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "deny",
      });
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe(
        "Approved 4×, rejected 1× (80% approval rate)",
      );
    });

    it("labels a 50-79% approval rate as mixed history", () => {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "deny",
      });
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe(
        "Mixed history: 1 approvals, 1 rejections",
      );
    });

    it("labels a <50% approval rate as mostly rejected", () => {
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
      for (let i = 0; i < 3; i++) {
        log.recordEvent("approval_decision", {
          toolName: "Bash",
          decision: "deny",
        });
      }
      const out = computeApprovalInsights(log);
      expect(out.tools[0]?.heuristicLabel).toBe(
        "Mostly rejected: 3 rejections vs 1 approvals",
      );
    });
  });
});
