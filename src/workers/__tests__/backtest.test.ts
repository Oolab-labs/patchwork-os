import { describe, expect, it } from "vitest";
import { backtestWorker, formatBacktestReport } from "../backtest.js";
import type { RunRecord } from "../shadowObserver.js";
import { parseWorker } from "../worker.js";

const SEVEN_HOURS = 7 * 3600 * 1000;
const issuer = parseWorker({
  id: "issuer",
  name: "Issuer",
  recipe: "file-issues",
  owns: ["issue"],
});

function issueRun(at: number, status: "ok" | "error", nSteps = 5): RunRecord {
  return {
    recipeName: "file-issues",
    at,
    steps: Array.from({ length: nSteps }, () => ({
      tool: "githubCreateIssue",
      status,
      ...(status === "error" && { haltReason: 'Tool "github" threw: boom' }),
    })),
  };
}

describe("backtestWorker", () => {
  it("counts early successes the ramp would have GATED as false-gate", () => {
    // The worker starts unearned → the ramp would QUEUE its first risky actions,
    // but they succeed → false-gate (over-caution), never false-allow.
    const r = backtestWorker(issuer, [issueRun(0, "ok", 3)]);
    expect(r.considered).toBe(3);
    expect(r.falseGate).toBeGreaterThan(0);
    expect(r.falseAllow).toBe(0);
    expect(r.divergences.every((d) => d.kind === "false-gate")).toBe(true);
  });

  it("counts a bad outcome the ramp would have AUTO-RUN as false-allow", () => {
    // 18 dwell-separated clean runs → the worker earns autonomy on `issue`, so
    // the ramp would BYPASS. Then a genuine failure → false-allow (over-trust).
    const goods = Array.from({ length: 18 }, (_, i) =>
      issueRun(i * SEVEN_HOURS, "ok"),
    );
    const fail = issueRun(18 * SEVEN_HOURS, "error");
    const r = backtestWorker(issuer, [...goods, fail]);
    expect(r.falseAllow).toBeGreaterThanOrEqual(1);
    expect(r.divergences.some((d) => d.kind === "false-allow")).toBe(true);
    // and it agreed on most of the earned-and-good actions
    expect(r.agreed).toBeGreaterThan(0);
    expect(r.agreementRate).toBeGreaterThan(0);
  });

  it("scores ONLY risky owned actions (reversible / unowned ignored)", () => {
    const r = backtestWorker(issuer, [
      {
        recipeName: "file-issues",
        at: 0,
        steps: [
          { tool: "getGitStatus", status: "ok" }, // reversible → ignored
          { tool: "gitPush", status: "ok" }, // vcs-push, NOT owned → ignored
          { tool: "githubCreateIssue", status: "ok" }, // issue, owned → scored
        ],
      },
    ]);
    expect(r.considered).toBe(1);
  });

  it("skips human approval-rejections (non-evidence)", () => {
    const r = backtestWorker(issuer, [
      {
        recipeName: "file-issues",
        at: 0,
        steps: [
          {
            tool: "githubCreateIssue",
            status: "error",
            haltReason: "Step rejected by approval gate — approval_rejected.",
          },
        ],
      },
    ]);
    expect(r.considered).toBe(0);
  });

  it("ignores runs for other recipes", () => {
    const r = backtestWorker(issuer, [
      {
        recipeName: "some-other",
        at: 0,
        steps: [{ tool: "githubCreateIssue", status: "ok" }],
      },
    ]);
    expect(r.considered).toBe(0);
  });

  it("formats a readable divergence report; surfaces false-allow", () => {
    const goods = Array.from({ length: 18 }, (_, i) =>
      issueRun(i * SEVEN_HOURS, "ok"),
    );
    const fail = issueRun(18 * SEVEN_HOURS, "error");
    const out = formatBacktestReport(backtestWorker(issuer, [...goods, fail]));
    expect(out).toContain("false-allow");
    expect(out).toContain("issuer");
  });

  it("empty history → nothing to calibrate", () => {
    const r = backtestWorker(issuer, []);
    expect(r.considered).toBe(0);
    expect(r.agreementRate).toBe(0);
    expect(formatBacktestReport(r)).toContain("nothing to calibrate");
  });
});
