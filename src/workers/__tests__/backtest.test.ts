import { describe, expect, it } from "vitest";
import { backtestWorker, formatBacktestReport } from "../backtest.js";
import type { OutcomeDisposition, OutcomeStore } from "../outcomeStore.js";
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

// A single filing carrying a captured issue URL (as github.create_issue does).
function issueRunUrl(at: number, url: string): RunRecord {
  return {
    recipeName: "file-issues",
    at,
    steps: [{ tool: "githubCreateIssue", status: "ok", output: { url } }],
  };
}
// Minimal OutcomeStore stand-in — backtest only calls getDisposition.
const fakeStore = (m: Record<string, OutcomeDisposition>) =>
  ({ getDisposition: (u: string) => m[u] ?? null }) as unknown as OutcomeStore;

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

  describe("outcome-store parity (matches the live dial labelling)", () => {
    const URL = "https://github.com/o/r/issues/99";
    // 18 dwell-separated url-less clean filings → the worker earns L4 on `issue`,
    // so by the 19th filing the ramp would BYPASS.
    const earned = Array.from({ length: 18 }, (_, i) =>
      issueRun(i * SEVEN_HOURS, "ok"),
    );

    it("a durable JUNK filing scores as a BAD outcome (false-allow), not a spurious good", () => {
      const history = [...earned, issueRunUrl(18 * SEVEN_HOURS, URL)];
      const withStore = backtestWorker(issuer, history, {
        outcomeStore: fakeStore({ [URL]: "junk" }),
      });
      const statusOnly = backtestWorker(issuer, history); // no store → old behaviour
      // The junk filing is the differentiator: with the store it is a BAD outcome
      // the earned ramp would auto-run → an extra false-allow the status-only
      // backtest misses entirely.
      expect(withStore.falseAllow).toBe(statusOnly.falseAllow + 1);
      expect(
        withStore.divergences.some(
          (d) => d.kind === "false-allow" && d.outcome === "bad",
        ),
      ).toBe(true);
    });

    it("a durable UNKNOWN filing is WITHHELD — excluded from the divergence sample", () => {
      const history = [...earned, issueRunUrl(18 * SEVEN_HOURS, URL)];
      const withUnknown = backtestWorker(issuer, history, {
        outcomeStore: fakeStore({ [URL]: "unknown" }),
      });
      const statusOnly = backtestWorker(issuer, history); // scores the filing as good
      // The unknown filing has no ground truth → not scored (one fewer considered)
      // rather than counted as a spurious "good".
      expect(withUnknown.considered).toBe(statusOnly.considered - 1);
    });

    it("a durable CONFIRMED filing scores as good — same as the status-only path", () => {
      const history = [...earned, issueRunUrl(18 * SEVEN_HOURS, URL)];
      const withConfirmed = backtestWorker(issuer, history, {
        outcomeStore: fakeStore({ [URL]: "confirmed" }),
      });
      const statusOnly = backtestWorker(issuer, history);
      expect(withConfirmed.considered).toBe(statusOnly.considered);
      expect(withConfirmed.falseAllow).toBe(statusOnly.falseAllow);
    });

    it("a JUNK filing INSIDE the durability window still scores BAD — parity with the live dial's instant demotion (#2)", () => {
      // The junk filing is only 1s old (well inside the 24h window); the earned
      // history is far older than the window, so the worker is L4 and the ramp
      // would BYPASS. Pre-#2 a recent junk filing was WITHHELD (waited out the
      // window); the reorder demotes it instantly, and the backtest inherits
      // that via the shared foldOutcome (#1068). Contrast: an UNKNOWN filing
      // inside the window is still withheld — the reorder is junk-only.
      const RECENT = 30 * SEVEN_HOURS;
      const nowInsideWindow = RECENT + 1000;
      const history = [...earned, issueRunUrl(RECENT, URL)];
      const junk = backtestWorker(issuer, history, {
        now: nowInsideWindow,
        outcomeStore: fakeStore({ [URL]: "junk" }),
      });
      const unknown = backtestWorker(issuer, history, {
        now: nowInsideWindow,
        outcomeStore: fakeStore({ [URL]: "unknown" }),
      });
      expect(
        junk.divergences.some(
          (d) => d.kind === "false-allow" && d.outcome === "bad",
        ),
      ).toBe(true);
      // Junk is scored (bad); unknown is withheld → exactly one fewer considered.
      expect(junk.considered).toBe(unknown.considered + 1);
    });
  });
});
