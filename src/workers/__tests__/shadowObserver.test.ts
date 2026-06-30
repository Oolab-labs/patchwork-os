import { describe, expect, it } from "vitest";
import type { GraduationConfig } from "../graduation.js";
import type { OutcomeDisposition, OutcomeStore } from "../outcomeStore.js";
import {
  isDurableSuccess,
  type RunRecord,
  WorkerShadowObserver,
} from "../shadowObserver.js";
import { parseWorker } from "../worker.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};

const release = parseWorker({
  id: "release-notes-worker",
  name: "Release Worker",
  recipe: "release-notes",
  owns: ["fs-write", "vcs-read"],
});

function editRun(at: number, steps: number): RunRecord {
  return {
    recipeName: "release-notes",
    at,
    steps: Array.from({ length: steps }, () => ({
      tool: "editText",
      status: "ok" as const,
    })),
  };
}

function climb(obs: WorkerShadowObserver) {
  obs.ingestRun(editRun(0, 60)); // build posterior (no climb at t=0)
  for (const at of [1000, 2000, 3000, 4000]) obs.ingestRun(editRun(at, 1));
}

describe("WorkerShadowObserver", () => {
  it("feeds attributed recipe-run outcomes into the worker's dial", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    climb(obs);
    const r = obs.report()[0]!;
    const fsWrite = r.board.find(
      (b) => b.classKey === "fs-write:reversible:medium",
    );
    expect(fsWrite?.level).toBe(4);
    expect(r.events.some((e) => e.type === "promote")).toBe(true);
  });

  it("ignores runs whose recipe maps to no worker", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    obs.ingestRun({
      recipeName: "some-other-recipe",
      at: 0,
      steps: [{ tool: "editText", status: "ok" }],
    });
    expect(obs.report()[0]!.board).toHaveLength(0);
  });

  it("compares ramp recommendation against the live gate decision", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    climb(obs); // fs-write earned L4 → ramp would bypass editText
    // gate DENIED an editText the ramp would now auto-run → divergence
    obs.ingestDecision({
      toolName: "editText",
      decision: "deny",
      at: 5000,
      recipeName: "test-recipe",
    });
    // gate ALLOWED an editText the ramp would also auto-run → agreement
    obs.ingestDecision({
      toolName: "editText",
      decision: "allow",
      at: 6000,
      recipeName: "test-recipe",
    });
    const r = obs.report()[0]!;
    expect(r.compared).toBe(2);
    expect(r.agreed).toBe(1);
    expect(r.divergences).toHaveLength(1);
    expect(r.divergences[0]!.ramp).toBe("bypass");
    expect(r.divergences[0]!.gate).toBe("deny");
  });

  it("skips decisions for tools no single worker owns (ambiguous attribution)", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    // slackPostMessage is messaging — release doesn't own it
    obs.ingestDecision({
      toolName: "slackPostMessage",
      decision: "deny",
      at: 0,
      recipeName: "test-recipe",
    });
    expect(obs.report()[0]!.compared).toBe(0);
  });

  it("skips decisions without recipeName (plain Claude-session MCP approvals)", () => {
    // Decisions without recipeName are Claude-session tool calls, not worker-gate
    // decisions. Including them inflates divergences with calls the worker gate
    // never saw (e.g. this Claude Code session approving github.create_issue
    // directly via its own general approvalGate).
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    climb(obs); // fs-write earned L4
    // No recipeName → should be skipped entirely
    obs.ingestDecision({ toolName: "editText", decision: "deny", at: 5000 });
    expect(obs.report()[0]!.compared).toBe(0);
  });

  it("counts a genuine tool error as evidence but NOT a human rejection (L2)", () => {
    // a real failure is evidence (shows up on the dial)
    const real = new WorkerShadowObserver([release], { cfg: CFG });
    real.ingestRun({
      recipeName: "release-notes",
      at: 0,
      steps: [
        {
          tool: "editText",
          status: "error",
          haltReason: 'Tool "editText" threw: boom',
        },
      ],
    });
    expect(
      real.report()[0]!.board.some((b) => b.classKey.startsWith("fs-write")),
    ).toBe(true);

    // a human reject/expire/cancel is a control decision, not a worker failure
    const rejected = new WorkerShadowObserver([release], { cfg: CFG });
    rejected.ingestRun({
      recipeName: "release-notes",
      at: 0,
      steps: [
        {
          tool: "editText",
          status: "error",
          haltReason: "Step rejected by approval gate — approval_rejected.",
        },
      ],
    });
    expect(
      rejected
        .report()[0]!
        .board.some((b) => b.classKey.startsWith("fs-write")),
    ).toBe(false); // skipped → no evidence → no demotion
  });

  it("flags board rows for classes the worker performs but does NOT own (L3)", () => {
    const obs = new WorkerShadowObserver([release], { cfg: CFG });
    // gitPush is vcs-push — release owns fs-write + vcs-read, NOT vcs-remote
    obs.ingestRun({
      recipeName: "release-notes",
      at: 0,
      steps: [{ tool: "gitPush", status: "ok" }],
    });
    const row = obs
      .report()[0]!
      .board.find((b) => b.classKey.startsWith("vcs-push"));
    expect(row).toBeDefined();
    expect(row!.owned).toBe(false);
  });
});

const W = 24 * 60 * 60 * 1000;

describe("isDurableSuccess (durable-outcome label)", () => {
  it("reversible successes are always durable (even brand-new)", () => {
    expect(isDurableSuccess("reversible", 1000, 1000, W)).toBe(true);
  });
  it("a non-reversible success is durable only after surviving the window", () => {
    const now = 100 * W;
    expect(isDurableSuccess("compensable", now - 1000, now, W)).toBe(false); // 1s ago → pending
    expect(isDurableSuccess("compensable", now - 2 * W, now, W)).toBe(true); // survived
    expect(isDurableSuccess("irreversible", now - 1000, now, W)).toBe(false);
    expect(isDurableSuccess("irreversible", now - 2 * W, now, W)).toBe(true);
  });
});

describe("WorkerShadowObserver — durable-outcome labelling", () => {
  const now = 100 * W;
  const issuer = parseWorker({
    id: "issuer",
    name: "Issuer",
    recipe: "file-issues",
    owns: ["issue"],
  });
  const issueRun = (at: number, status: "ok" | "error" = "ok"): RunRecord => ({
    recipeName: "file-issues",
    at,
    steps: [{ tool: "githubCreateIssue", status }],
  });
  const issueRow = (obs: WorkerShadowObserver) =>
    obs.report()[0]!.board.find((b) => b.classKey.startsWith("issue"));

  it("WITHHOLDS a recent non-reversible success (the #1041 junk-issue case)", () => {
    const obs = new WorkerShadowObserver([issuer], { cfg: CFG, now });
    obs.ingestRun(issueRun(now - 1000)); // filed 1s ago → not yet durable
    expect(issueRow(obs)).toBeUndefined(); // no evidence on the issue class
  });

  it("COUNTS a non-reversible success once it has survived the window", () => {
    const obs = new WorkerShadowObserver([issuer], { cfg: CFG, now });
    obs.ingestRun(issueRun(now - 2 * W)); // 2 days ago → durable
    expect(issueRow(obs)?.observations).toBe(1);
  });

  it("counts a recent FAILURE immediately (failure is durable evidence)", () => {
    const obs = new WorkerShadowObserver([issuer], { cfg: CFG, now });
    obs.ingestRun(issueRun(now - 1000, "error"));
    expect(issueRow(obs)?.observations).toBe(1);
  });

  it("without `now`, falls back to status-only (recent success counts) — back-compat", () => {
    const obs = new WorkerShadowObserver([issuer], { cfg: CFG }); // no now
    obs.ingestRun(issueRun(now - 1000));
    expect(issueRow(obs)?.observations).toBe(1);
  });
});

describe("WorkerShadowObserver — outcome verification (junk → good:false)", () => {
  const now = 100 * W;
  const URL = "https://github.com/o/r/issues/1";
  const issuer = parseWorker({
    id: "issuer",
    name: "Issuer",
    recipe: "file-issues",
    owns: ["issue"],
  });
  // A DURABLE (past-window) issue filing carrying the captured URL.
  const durableFiling = (url?: string): RunRecord => ({
    recipeName: "file-issues",
    at: now - 2 * W,
    steps: [
      {
        tool: "githubCreateIssue",
        status: "ok",
        ...(url ? { output: { url } } : {}),
      },
    ],
  });
  const issueRow = (obs: WorkerShadowObserver) =>
    obs.report()[0]!.board.find((b) => b.classKey.startsWith("issue"));
  // Minimal stand-in for OutcomeStore — the observer only calls getDisposition.
  const fakeStore = (m: Record<string, OutcomeDisposition>) =>
    ({
      getDisposition: (u: string) => m[u] ?? null,
    }) as unknown as OutcomeStore;

  it("folds a durable JUNK filing as good:false (lowers trust, not neutral)", () => {
    const junk = new WorkerShadowObserver([issuer], {
      cfg: CFG,
      now,
      outcomeStore: fakeStore({ [URL]: "junk" }),
    });
    junk.ingestRun(durableFiling(URL));
    const confirmed = new WorkerShadowObserver([issuer], {
      cfg: CFG,
      now,
      outcomeStore: fakeStore({ [URL]: "confirmed" }),
    });
    confirmed.ingestRun(durableFiling(URL));

    // Both record one observation (a junk filing is still EVIDENCE)…
    expect(issueRow(junk)?.observations).toBe(1);
    expect(issueRow(confirmed)?.observations).toBe(1);
    // …but the junk posterior mean is strictly LOWER — proving good:false was
    // folded for junk and good:true for confirmed (the #1046 noise case).
    expect(issueRow(junk)!.mean).toBeLessThan(issueRow(confirmed)!.mean);
  });

  it("confirmed and unknown dispositions both keep the good:true path (identical dial)", () => {
    const confirmed = new WorkerShadowObserver([issuer], {
      cfg: CFG,
      now,
      outcomeStore: fakeStore({ [URL]: "confirmed" }),
    });
    confirmed.ingestRun(durableFiling(URL));
    // unknown = no record for the URL → getDisposition null → weak not-reverted path
    const unknown = new WorkerShadowObserver([issuer], {
      cfg: CFG,
      now,
      outcomeStore: fakeStore({}),
    });
    unknown.ingestRun(durableFiling(URL));
    expect(issueRow(unknown)!.mean).toBe(issueRow(confirmed)!.mean);
  });

  it("ignores the outcome store before the durability window (still pending)", () => {
    const obs = new WorkerShadowObserver([issuer], {
      cfg: CFG,
      now,
      outcomeStore: fakeStore({ [URL]: "junk" }),
    });
    // filed 1s ago — junk or not, a non-durable success earns nothing yet.
    obs.ingestRun({
      recipeName: "file-issues",
      at: now - 1000,
      steps: [
        { tool: "githubCreateIssue", status: "ok", output: { url: URL } },
      ],
    });
    expect(issueRow(obs)).toBeUndefined();
  });

  it("a durable filing with no captured URL falls through to good:true (back-compat)", () => {
    const obs = new WorkerShadowObserver([issuer], {
      cfg: CFG,
      now,
      outcomeStore: fakeStore({ [URL]: "junk" }),
    });
    obs.ingestRun(durableFiling()); // no output.url → no lookup
    const baseline = new WorkerShadowObserver([issuer], { cfg: CFG, now });
    baseline.ingestRun(durableFiling());
    expect(issueRow(obs)!.mean).toBe(issueRow(baseline)!.mean);
  });
});
