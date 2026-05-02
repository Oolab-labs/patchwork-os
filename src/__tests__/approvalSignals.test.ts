import { describe, expect, it } from "vitest";
// Importing the tools index for its side-effect: it registers all
// built-in tools (including the connector-flagged ones like gmail.*,
// linear.*, slack.*) into the toolRegistry that
// isConnectorNamespace consults. Without this, every connector test
// falls back to the "first_tool_use" branch.
import "../recipes/tools/index.js";
import { ActivityLog } from "../activityLog.js";
import { computePersonalSignals } from "../approvalSignals.js";

/**
 * Convenience helper — feed N approval_decision lifecycle rows for a
 * given tool/decision pair into a fresh ActivityLog. The signal-
 * computation path is the same one a real approval would walk; this
 * just bypasses the HTTP handler.
 */
function logWithApprovals(
  rows: Array<{ toolName: string; decision: "allow" | "deny" }>,
): ActivityLog {
  const log = new ActivityLog();
  for (const r of rows) {
    log.recordEvent("approval_decision", {
      toolName: r.toolName,
      decision: r.decision,
    });
  }
  return log;
}

describe("computePersonalSignals", () => {
  describe("heuristic 1 — prior approvals", () => {
    it("does not surface below the 3-approval threshold", () => {
      const log = logWithApprovals([
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "prior_approvals")).toBeUndefined();
    });

    it("surfaces at exactly 3 approvals", () => {
      const log = logWithApprovals([
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "prior_approvals");
      expect(sig).toBeDefined();
      expect(sig?.count).toBe(3);
      expect(sig?.severity).toBe("low");
      expect(sig?.source).toBe("approval_history");
    });

    it("does not include rejections in the approval count", () => {
      const log = logWithApprovals([
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "deny" }, // not counted
        { toolName: "Bash", decision: "deny" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "prior_approvals")).toBeUndefined();
    });

    it("does not include other tools", () => {
      const log = logWithApprovals([
        { toolName: "Read", decision: "allow" },
        { toolName: "Read", decision: "allow" },
        { toolName: "Read", decision: "allow" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "prior_approvals")).toBeUndefined();
    });

    it("upgrades the label phrasing past 100 approvals", () => {
      const rows = Array.from({ length: 105 }, () => ({
        toolName: "Bash",
        decision: "allow" as const,
      }));
      const log = logWithApprovals(rows);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "prior_approvals");
      expect(sig?.label).toMatch(/well-trusted/);
      expect(sig?.count).toBe(105);
    });
  });

  describe("heuristic 2 — prior rejections", () => {
    it("surfaces at any prior rejection (≥ 1)", () => {
      const log = logWithApprovals([{ toolName: "gitPush", decision: "deny" }]);
      const signals = computePersonalSignals({
        toolName: "gitPush",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "prior_rejection");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("medium"); // single rejection
      expect(sig?.count).toBe(1);
    });

    it("escalates to high severity at ≥ 2 rejections", () => {
      const log = logWithApprovals([
        { toolName: "gitPush", decision: "deny" },
        { toolName: "gitPush", decision: "deny" },
      ]);
      const signals = computePersonalSignals({
        toolName: "gitPush",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "prior_rejection");
      expect(sig?.severity).toBe("high");
      expect(sig?.count).toBe(2);
      expect(sig?.label).toMatch(/recurring pattern/);
    });

    it("does not surface when prior decisions were all allows", () => {
      const log = logWithApprovals([
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "prior_rejection")).toBeUndefined();
    });

    it("co-exists with prior_approvals when the user both approved and rejected", () => {
      const log = logWithApprovals([
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "deny" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      // Both heuristics should fire — the user's history is genuinely
      // mixed and the modal should show both signals so the human sees
      // the full picture, not just the most-recent decision.
      expect(signals.find((s) => s.kind === "prior_approvals")).toBeDefined();
      expect(signals.find((s) => s.kind === "prior_rejection")).toBeDefined();
    });
  });

  describe("heuristic 3 — first connector / first tool use", () => {
    it("flags first connector use with high severity for known connector namespaces", () => {
      const log = new ActivityLog();
      // No prior gmail.* activity.
      const signals = computePersonalSignals({
        toolName: "gmail.fetch_unread",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "first_connector_use");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("high");
      expect(sig?.label).toMatch(/gmail connector/);
    });

    it("does not flag connector use when prior namespace activity exists", () => {
      const log = new ActivityLog();
      log.record("gmail.fetch_unread", 100, "success");
      const signals = computePersonalSignals({
        toolName: "gmail.send",
        activityLog: log,
      });
      expect(
        signals.find((s) => s.kind === "first_connector_use"),
      ).toBeUndefined();
    });

    it("flags first_tool_use for unknown namespace (low severity)", () => {
      const log = new ActivityLog();
      const signals = computePersonalSignals({
        toolName: "myCustom.doThing",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "first_tool_use");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("low");
      expect(sig?.label).toMatch(/myCustom/);
    });

    it("does not flag for top-level (non-namespaced) tools — those would fire on every fresh session", () => {
      const log = new ActivityLog();
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(
        signals.find(
          (s) =>
            s.kind === "first_connector_use" || s.kind === "first_tool_use",
        ),
      ).toBeUndefined();
    });
  });

  describe("composition", () => {
    it("returns an empty array for an empty log + non-namespaced tool", () => {
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: new ActivityLog(),
      });
      expect(signals).toEqual([]);
    });

    it("returns multiple signals when multiple heuristics fire", () => {
      const log = new ActivityLog();
      // Three prior approvals + zero prior gmail.* activity.
      for (let i = 0; i < 3; i++) {
        log.recordEvent("approval_decision", {
          toolName: "gmail.send",
          decision: "allow",
        });
      }
      const signals = computePersonalSignals({
        toolName: "gmail.send",
        activityLog: log,
      });
      // prior_approvals fires (3 ≥ threshold); first_connector_use does
      // NOT fire (the recorded items are LIFECYCLE rows, not activity
      // rows — so queryByNamespace returns empty even though there are
      // prior approvals). This is intentional: connector novelty tracks
      // tool execution, not approval decisions.
      expect(signals.find((s) => s.kind === "prior_approvals")).toBeDefined();
      expect(
        signals.find((s) => s.kind === "first_connector_use"),
      ).toBeDefined();
    });

    it("is idempotent — calling twice with the same inputs returns the same signals", () => {
      const log = logWithApprovals([
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
        { toolName: "Bash", decision: "allow" },
      ]);
      const a = computePersonalSignals({ toolName: "Bash", activityLog: log });
      const b = computePersonalSignals({ toolName: "Bash", activityLog: log });
      expect(b).toEqual(a);
    });
  });
});
