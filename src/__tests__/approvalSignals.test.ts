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

    it("heuristic 5 — surfaces stale_tool_use when last call ≥ 7 days ago", () => {
      const log = new ActivityLog();
      const tenDaysAgo = new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      // Inject directly via record() then mutate the timestamp on the
      // most recent entry — record() always stamps Date.now().
      log.record("Bash", 5, "success");
      const last = log.queryLastToolCall("Bash");
      if (last) (last as { timestamp: string }).timestamp = tenDaysAgo;

      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "stale_tool_use");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("low");
      expect(sig?.source).toBe("activity_history");
      expect(sig?.count).toBe(10);
    });

    it("heuristic 5 — does not surface when last call is within the threshold", () => {
      const log = new ActivityLog();
      log.record("Bash", 5, "success"); // recorded just now
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "stale_tool_use")).toBeUndefined();
    });

    it("heuristic 5 — escalates to medium severity past 30 days", () => {
      const log = new ActivityLog();
      const fortyDaysAgo = new Date(
        Date.now() - 40 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      log.record("Bash", 5, "success");
      const last = log.queryLastToolCall("Bash");
      if (last) (last as { timestamp: string }).timestamp = fortyDaysAgo;

      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "stale_tool_use");
      expect(sig?.severity).toBe("medium");
    });

    it("heuristic 5 — silent when there is no prior call (first-use is heuristic 3's job)", () => {
      const log = new ActivityLog();
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "stale_tool_use")).toBeUndefined();
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

  describe("heuristic 7 — risk tier escalation", () => {
    function logWithTieredAllows(tiers: Array<"low" | "medium" | "high">) {
      const log = new ActivityLog();
      for (const tier of tiers) {
        log.recordEvent("approval_decision", {
          toolName: "anyTool",
          decision: "allow",
          tier,
        });
      }
      return log;
    }

    it("does not surface below the 5-sample baseline", () => {
      const log = logWithTieredAllows(["low", "low", "low"]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentTier: "high",
      });
      expect(signals.find((s) => s.kind === "tier_escalation")).toBeUndefined();
    });

    it("does not surface when current tier matches the baseline", () => {
      const log = logWithTieredAllows(["low", "low", "low", "low", "low"]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentTier: "low",
      });
      expect(signals.find((s) => s.kind === "tier_escalation")).toBeUndefined();
    });

    it("surfaces with medium severity on a 1-tier jump (low baseline → medium)", () => {
      const log = logWithTieredAllows(["low", "low", "low", "low", "low"]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentTier: "medium",
      });
      const sig = signals.find((s) => s.kind === "tier_escalation");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("medium");
      expect(sig?.label).toMatch(/usually approve low/);
      expect(sig?.label).toMatch(/medium/);
    });

    it("surfaces with high severity on a 2-tier jump (low baseline → high)", () => {
      const log = logWithTieredAllows(["low", "low", "low", "low", "low"]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentTier: "high",
      });
      const sig = signals.find((s) => s.kind === "tier_escalation");
      expect(sig?.severity).toBe("high");
    });

    it("uses the median, not the max, of recent tiers", () => {
      const log = logWithTieredAllows([
        "low",
        "low",
        "low",
        "low",
        "low",
        "high",
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentTier: "medium",
      });
      const sig = signals.find((s) => s.kind === "tier_escalation");
      expect(sig).toBeDefined(); // baseline=low (median), current=medium → escalation
    });

    it("ignores rejections when computing baseline", () => {
      const log = new ActivityLog();
      for (let i = 0; i < 5; i++) {
        log.recordEvent("approval_decision", {
          toolName: "x",
          decision: "deny",
          tier: "low",
        });
      }
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentTier: "high",
      });
      expect(signals.find((s) => s.kind === "tier_escalation")).toBeUndefined();
    });

    it("is silent when currentTier is omitted", () => {
      const log = logWithTieredAllows(["low", "low", "low", "low", "low"]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "tier_escalation")).toBeUndefined();
    });
  });

  describe("heuristic 8 — co-occurrence pattern", () => {
    function logWithCoOccurrence(
      pairs: Array<[string, string]>,
      gapMs = 1_000,
    ): ActivityLog {
      const log = new ActivityLog();
      let t = Date.now() - 60_000;
      for (const [a, b] of pairs) {
        log.record(a, 5, "success");
        const ea = (
          log as unknown as { entries: Array<{ timestamp: string }> }
        ).entries.at(-1);
        if (ea) ea.timestamp = new Date(t).toISOString();
        t += gapMs;
        log.record(b, 5, "success");
        const eb = (
          log as unknown as { entries: Array<{ timestamp: string }> }
        ).entries.at(-1);
        if (eb) eb.timestamp = new Date(t).toISOString();
        t += gapMs;
      }
      return log;
    }

    it("does not surface below the 3-occurrence floor", () => {
      // Single pair → count = 1 (one ordered entry pair within window).
      const log = logWithCoOccurrence([["Bash", "Read"]]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(
        signals.find((s) => s.kind === "cooccurrence_pattern"),
      ).toBeUndefined();
    });

    it("surfaces the partner once the count crosses the floor", () => {
      // 2 emissions produce 4 ordered entry pairs within the window —
      // well past the 3-count floor.
      const log = logWithCoOccurrence([
        ["Bash", "Read"],
        ["Bash", "Read"],
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "cooccurrence_pattern");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("low");
      expect(sig?.label).toMatch(/Read/);
      expect(sig?.count).toBeGreaterThanOrEqual(3);
    });

    it("picks the strongest partner, not just any partner", () => {
      const log = logWithCoOccurrence([
        ["Bash", "Read"],
        ["Bash", "Read"],
        ["Bash", "Read"],
        ["Bash", "Edit"],
        ["Bash", "Edit"],
        ["Bash", "Edit"],
        ["Bash", "Edit"],
        ["Bash", "Edit"],
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "cooccurrence_pattern");
      expect(sig?.label).toMatch(/Edit/);
    });

    it("does not surface when this tool is not part of any pair", () => {
      const log = logWithCoOccurrence([
        ["Read", "Edit"],
        ["Read", "Edit"],
        ["Read", "Edit"],
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(
        signals.find((s) => s.kind === "cooccurrence_pattern"),
      ).toBeUndefined();
    });
  });

  describe("heuristic 9 — workspace mismatch", () => {
    function logWithWorkspaceApprovals(
      rows: Array<{ toolName: string; workspace: string }>,
    ) {
      const log = new ActivityLog();
      for (const r of rows) {
        log.recordEvent("approval_decision", {
          toolName: r.toolName,
          decision: "allow",
          workspace: r.workspace,
        });
      }
      return log;
    }

    it("surfaces when this workspace has no prior approval but others do", () => {
      const log = logWithWorkspaceApprovals([
        { toolName: "Bash", workspace: "/repo/alpha" },
        { toolName: "Bash", workspace: "/repo/alpha" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentWorkspace: "/repo/beta",
      });
      const sig = signals.find((s) => s.kind === "workspace_mismatch");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("medium");
      expect(sig?.count).toBe(1); // 1 other unique workspace
      expect(sig?.label).toMatch(/different workspace/);
    });

    it("does not surface when current workspace has prior approval", () => {
      const log = logWithWorkspaceApprovals([
        { toolName: "Bash", workspace: "/repo/alpha" },
        { toolName: "Bash", workspace: "/repo/beta" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentWorkspace: "/repo/beta",
      });
      expect(
        signals.find((s) => s.kind === "workspace_mismatch"),
      ).toBeUndefined();
    });

    it("does not surface when no prior rows carry workspace metadata", () => {
      // Older rows (pre-this-PR) — no workspace field. h9 must treat as
      // "no baseline" rather than firing on every call.
      const log = new ActivityLog();
      log.recordEvent("approval_decision", {
        toolName: "Bash",
        decision: "allow",
      });
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentWorkspace: "/repo/beta",
      });
      expect(
        signals.find((s) => s.kind === "workspace_mismatch"),
      ).toBeUndefined();
    });

    it("counts unique workspaces, not raw rows", () => {
      const log = logWithWorkspaceApprovals([
        { toolName: "Bash", workspace: "/repo/alpha" },
        { toolName: "Bash", workspace: "/repo/alpha" },
        { toolName: "Bash", workspace: "/repo/alpha" },
        { toolName: "Bash", workspace: "/repo/gamma" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
        currentWorkspace: "/repo/beta",
      });
      const sig = signals.find((s) => s.kind === "workspace_mismatch");
      expect(sig?.count).toBe(2); // alpha + gamma
    });

    it("is silent when currentWorkspace omitted", () => {
      const log = logWithWorkspaceApprovals([
        { toolName: "Bash", workspace: "/repo/alpha" },
      ]);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(
        signals.find((s) => s.kind === "workspace_mismatch"),
      ).toBeUndefined();
    });
  });

  describe("heuristic 12 — cooldown breach", () => {
    function logWithBurst(toolName: string, count: number, gapMs = 1_000) {
      const log = new ActivityLog();
      let t = Date.now() - count * gapMs;
      for (let i = 0; i < count; i++) {
        log.record(toolName, 5, "success");
        const e = (
          log as unknown as { entries: Array<{ timestamp: string }> }
        ).entries.at(-1);
        if (e) e.timestamp = new Date(t).toISOString();
        t += gapMs;
      }
      return log;
    }

    it("does not surface below 3 calls in window", () => {
      const log = logWithBurst("Bash", 2);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "cooldown_breach")).toBeUndefined();
    });

    it("surfaces with medium severity at 3 calls in window", () => {
      const log = logWithBurst("Bash", 3);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "cooldown_breach");
      expect(sig).toBeDefined();
      expect(sig?.severity).toBe("medium");
      expect(sig?.count).toBe(3);
      expect(sig?.label).toMatch(/runaway loop/);
    });

    it("escalates to high severity at 6+ calls", () => {
      const log = logWithBurst("Bash", 7);
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      const sig = signals.find((s) => s.kind === "cooldown_breach");
      expect(sig?.severity).toBe("high");
      expect(sig?.count).toBe(7);
    });

    it("ignores calls older than the 5-minute window", () => {
      const log = new ActivityLog();
      // Three old calls (10 min ago) — outside window
      const oldTime = Date.now() - 10 * 60 * 1_000;
      for (let i = 0; i < 3; i++) {
        log.record("Bash", 5, "success");
        const e = (
          log as unknown as { entries: Array<{ timestamp: string }> }
        ).entries.at(-1);
        if (e) e.timestamp = new Date(oldTime + i * 1_000).toISOString();
      }
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "cooldown_breach")).toBeUndefined();
    });

    it("only counts calls to the same tool", () => {
      const log = new ActivityLog();
      for (let i = 0; i < 3; i++) log.record("Read", 5, "success");
      const signals = computePersonalSignals({
        toolName: "Bash",
        activityLog: log,
      });
      expect(signals.find((s) => s.kind === "cooldown_breach")).toBeUndefined();
    });
  });
});
