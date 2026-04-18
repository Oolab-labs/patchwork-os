import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog } from "../../activityLog.js";
import { CommitIssueLinkLog } from "../../commitIssueLinkLog.js";
import { DecisionTraceLog } from "../../decisionTraceLog.js";
import { RecipeRunLog } from "../../runLog.js";
import { createCtxQueryTracesTool } from "../ctxQueryTraces.js";

let dir: string;
let linkLog: CommitIssueLinkLog;
let runLog: RecipeRunLog;
let activityLog: ActivityLog;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ctx-query-traces-"));
  linkLog = new CommitIssueLinkLog({ dir });
  runLog = new RecipeRunLog({ dir });
  activityLog = new ActivityLog({ logDir: dir, maxEntries: 100 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function seed() {
  linkLog.record({
    sha: "abc",
    ref: "#42",
    linkType: "closes",
    resolved: true,
    workspace: "/ws",
    subject: "fix thing",
    issueState: "OPEN",
  });
  runLog.record({
    id: "task-1",
    triggerSource: "cron:nightly",
    status: "done",
    createdAt: 1000,
    startedAt: 1000,
    doneAt: 1100,
  });
  activityLog.recordEvent("approval_decision", {
    toolName: "gitPush",
    decision: "deny",
    reason: "cc_deny_rule",
    sessionId: "s1",
    summary: "push to main",
  });
}

describe("ctxQueryTraces", () => {
  it("returns traces from all three sources when no filter", async () => {
    seed();
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    const res = parse(await tool.handler({}));
    expect(res.count).toBe(3);
    const types = res.traces.map((t: { traceType: string }) => t.traceType);
    expect(types).toContain("approval");
    expect(types).toContain("enrichment");
    expect(types).toContain("recipe_run");
  });

  it("filters by traceType", async () => {
    seed();
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    const res = parse(await tool.handler({ traceType: "approval" }));
    expect(res.count).toBe(1);
    expect(res.traces[0].traceType).toBe("approval");
    expect(res.traces[0].key).toBe("s1:gitPush");
    expect(res.traces[0].summary).toContain("deny");
    expect(res.traces[0].body.summary).toBe("push to main");
  });

  it("filters by key substring", async () => {
    linkLog.record({
      sha: "aaa",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    linkLog.record({
      sha: "bbb",
      ref: "#2",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
    });
    const res = parse(await tool.handler({ key: "aaa:#1" }));
    expect(res.count).toBe(1);
    expect(res.traces[0].body.sha).toBe("aaa");
  });

  it("filters by since (ms epoch)", async () => {
    seed();
    // Recipe run has doneAt=1100. Approval + enrichment use Date.now / createdAt.
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    // Exclude recipe run (ts=1100) by filtering since=10000.
    const res = parse(await tool.handler({ since: 10_000 }));
    const types = res.traces.map((t: { traceType: string }) => t.traceType);
    expect(types).not.toContain("recipe_run");
  });

  it("returns results newest-first", async () => {
    seed();
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    const res = parse(await tool.handler({}));
    for (let i = 1; i < res.traces.length; i += 1) {
      expect(res.traces[i - 1].ts).toBeGreaterThanOrEqual(res.traces[i].ts);
    }
  });

  it("reports source availability", async () => {
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
    });
    const res = parse(await tool.handler({}));
    expect(res.sources).toEqual({
      approval: false,
      enrichment: true,
      recipe_run: false,
      decision: false,
    });
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      linkLog.record({
        sha: `sha${i}`,
        ref: "#1",
        linkType: "closes",
        resolved: true,
        workspace: "/ws",
      });
    }
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
    });
    const res = parse(await tool.handler({ limit: 2 }));
    expect(res.count).toBe(2);
  });

  it("returns empty when no deps provided", async () => {
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: null,
      recipeRunLog: null,
    });
    const res = parse(await tool.handler({}));
    expect(res.count).toBe(0);
    expect(res.traces).toEqual([]);
  });

  it("captures riskSignals and callId from approval events", async () => {
    activityLog.recordEvent("approval_decision", {
      toolName: "Bash",
      decision: "allow",
      reason: "approved",
      sessionId: "s2",
      callId: "call-xyz",
      summary: "rm tmpfile",
      riskSignals: [
        { kind: "destructive_flag", label: "rm flag", severity: "medium" },
      ],
    });
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: null,
      recipeRunLog: null,
    });
    const res = parse(await tool.handler({ traceType: "approval" }));
    expect(res.traces[0].body.callId).toBe("call-xyz");
    expect(res.traces[0].body.summary).toBe("rm tmpfile");
    expect(res.traces[0].body.riskSignals).toHaveLength(1);
  });

  it("includes decision traces when decisionTraceLog is provided", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#42",
      problem: "auth timeout",
      solution: "lazy cache init",
      workspace: "/ws",
      tags: ["perf"],
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: null,
      recipeRunLog: null,
      decisionTraceLog: decisionLog,
    });
    const res = parse(await tool.handler({}));
    expect(res.sources.decision).toBe(true);
    expect(res.count).toBe(1);
    expect(res.traces[0].traceType).toBe("decision");
    expect(res.traces[0].key).toBe("#42");
    expect(res.traces[0].summary).toContain("lazy cache init");
  });

  it("filters by traceType=decision", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#1",
      problem: "p",
      solution: "s",
      workspace: "/ws",
    });
    linkLog.record({
      sha: "aaa",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
      decisionTraceLog: decisionLog,
    });
    const res = parse(await tool.handler({ traceType: "decision" }));
    expect(res.count).toBe(1);
    expect(res.traces[0].traceType).toBe("decision");
  });
});

describe("ctxQueryTraces — q (text search)", () => {
  it("matches on summary (case-insensitive)", async () => {
    seed();
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    const res = parse(await tool.handler({ q: "DENY" }));
    expect(res.count).toBeGreaterThan(0);
    for (const t of res.traces) {
      const hay = JSON.stringify(t).toLowerCase();
      expect(hay).toContain("deny");
    }
  });

  it("matches inside body (serialized JSON)", async () => {
    linkLog.record({
      sha: "zzz",
      ref: "#99",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
      subject: "needle-in-body-field",
      issueState: "OPEN",
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
    });
    const res = parse(await tool.handler({ q: "needle-in-body-field" }));
    expect(res.count).toBe(1);
    expect(res.traces[0].key).toBe("zzz:#99");
  });

  it("returns empty when q matches nothing", async () => {
    seed();
    const tool = createCtxQueryTracesTool({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    const res = parse(await tool.handler({ q: "xyzzy-not-present" }));
    expect(res.count).toBe(0);
    expect(res.traces).toEqual([]);
  });

  it("combines with traceType and key filters (AND semantics)", async () => {
    linkLog.record({
      sha: "match",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
      subject: "pineapple",
      issueState: "OPEN",
    });
    linkLog.record({
      sha: "nope",
      ref: "#2",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
      subject: "apricot",
      issueState: "OPEN",
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
    });
    const res = parse(
      await tool.handler({ traceType: "enrichment", q: "pineapple" }),
    );
    expect(res.count).toBe(1);
    expect(res.traces[0].body.subject).toBe("pineapple");
  });
});

describe("ctxQueryTraces — tag filter", () => {
  it("restricts to decision traces carrying the tag", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#1",
      problem: "p1",
      solution: "s1",
      workspace: "/ws",
      tags: ["perf", "db"],
    });
    decisionLog.record({
      ref: "#2",
      problem: "p2",
      solution: "s2",
      workspace: "/ws",
      tags: ["ui"],
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: null,
      recipeRunLog: null,
      decisionTraceLog: decisionLog,
    });
    const res = parse(await tool.handler({ tag: "perf" }));
    expect(res.count).toBe(1);
    expect(res.traces[0].body.ref).toBe("#1");
  });

  it("excludes non-decision trace types when tag is set", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#1",
      problem: "p",
      solution: "s",
      workspace: "/ws",
      tags: ["perf"],
    });
    // Enrichment row with no tags — should be filtered out entirely.
    linkLog.record({
      sha: "aaa",
      ref: "#99",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: linkLog,
      recipeRunLog: null,
      decisionTraceLog: decisionLog,
    });
    const res = parse(await tool.handler({ tag: "perf" }));
    expect(res.count).toBe(1);
    expect(res.traces[0].traceType).toBe("decision");
  });

  it("returns nothing when no decision carries the tag", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#1",
      problem: "p",
      solution: "s",
      workspace: "/ws",
      tags: ["ui"],
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: null,
      recipeRunLog: null,
      decisionTraceLog: decisionLog,
    });
    const res = parse(await tool.handler({ tag: "missing" }));
    expect(res.count).toBe(0);
  });

  it("tag is exact-match, case-sensitive", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#1",
      problem: "p",
      solution: "s",
      workspace: "/ws",
      tags: ["Perf"],
    });
    const tool = createCtxQueryTracesTool({
      activityLog: null,
      commitIssueLinkLog: null,
      recipeRunLog: null,
      decisionTraceLog: decisionLog,
    });
    expect(parse(await tool.handler({ tag: "perf" })).count).toBe(0);
    expect(parse(await tool.handler({ tag: "Perf" })).count).toBe(1);
  });
});
