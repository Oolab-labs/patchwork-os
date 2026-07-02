import { describe, expect, it } from "vitest";
import type { HaltCategory } from "../haltCategory";
import { ownerHaltPhrase } from "../haltPhrasing";

describe("ownerHaltPhrase", () => {
  it("auth_failure names the service + a reconnect fix", () => {
    const p = ownerHaltPhrase("auth_failure", "GitHub");
    expect(p.sentence).toBe("It can't sign in to GitHub anymore.");
    expect(p.fix).toBe("reconnect");
    expect(p.fixLabel).toBe("Reconnect");
  });

  it("missing_connector → connect", () => {
    const p = ownerHaltPhrase("missing_connector", "Slack");
    expect(p.sentence).toContain("Slack");
    expect(p.fix).toBe("connect");
  });

  it("rate_limited → wait, no fix button", () => {
    expect(ownerHaltPhrase("rate_limited", "GitHub").fix).toBe("wait");
    // Falls back gracefully with no service.
    expect(ownerHaltPhrase("rate_limited").sentence).toMatch(/slow down/);
  });

  it("budget_exceeded → raise-budget", () => {
    expect(ownerHaltPhrase("budget_exceeded").fix).toBe("raise-budget");
  });

  it("kill_switch → release-kill-switch, plain safety-switch wording", () => {
    const p = ownerHaltPhrase("kill_switch");
    expect(p.fix).toBe("release-kill-switch");
    expect(p.sentence).toMatch(/safety switch/i);
  });

  it("approval_rejected → none", () => {
    expect(ownerHaltPhrase("approval_rejected").fix).toBe("none");
  });

  it("engine categories collapse to see-what-happened", () => {
    for (const c of ["tool_error", "agent_silent_fail", "expect_failed", "run_level", "unknown"] as HaltCategory[]) {
      expect(ownerHaltPhrase(c).fix).toBe("open-trace");
    }
  });

  it("uses a generic service when none is given for auth_failure", () => {
    expect(ownerHaltPhrase("auth_failure").sentence).toMatch(/the service it needs/);
  });

  it("no sentence contains engineer jargon", () => {
    const banned = /expect:|tokensMax|connector|cron|LCB|disposition|actionClass/i;
    const cats: HaltCategory[] = [
      "auth_failure",
      "missing_connector",
      "rate_limited",
      "network_error",
      "budget_exceeded",
      "kill_switch",
      "approval_rejected",
      "step_timeout",
      "expect_failed",
      "agent_silent_fail",
      "agent_narration_only",
      "agent_threw",
      "tool_threw",
      "tool_error",
      "run_level",
      "unknown",
    ];
    for (const c of cats) {
      expect(ownerHaltPhrase(c, "GitHub").sentence).not.toMatch(banned);
    }
  });
});
