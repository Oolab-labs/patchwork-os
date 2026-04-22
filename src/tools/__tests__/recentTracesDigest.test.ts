import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog } from "../../activityLog.js";
import { CommitIssueLinkLog } from "../../commitIssueLinkLog.js";
import { DecisionTraceLog } from "../../decisionTraceLog.js";
import { RecipeRunLog } from "../../runLog.js";
import { buildRecentTracesDigest } from "../recentTracesDigest.js";

let dir: string;
let linkLog: CommitIssueLinkLog;
let runLog: RecipeRunLog;
let activityLog: ActivityLog;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "recent-traces-digest-"));
  linkLog = new CommitIssueLinkLog({ dir });
  runLog = new RecipeRunLog({ dir });
  activityLog = new ActivityLog({ logDir: dir, maxEntries: 100 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildRecentTracesDigest", () => {
  it("returns empty array when no sources are wired", async () => {
    const lines = await buildRecentTracesDigest({});
    expect(lines).toEqual([]);
  });

  it("returns empty array when sources are empty", async () => {
    const lines = await buildRecentTracesDigest({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    expect(lines).toEqual([]);
  });

  it("emits heading + bullet for a single approval trace", async () => {
    activityLog.recordEvent("approval_decision", {
      toolName: "gitPush",
      decision: "deny",
      reason: "cc_deny_rule",
      sessionId: "s1",
    });
    // activityLog uses Date.now() via recordEvent; use the real clock as `now`.
    const lines = await buildRecentTracesDigest({ activityLog });
    expect(lines[0]).toBe("RECENT DECISIONS (last 12h):");
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatch(/deny gitPush.*cc_deny_rule.*ago/);
  });

  it("renders different icons per traceType", async () => {
    const now = Date.now();
    activityLog.recordEvent("approval_decision", {
      toolName: "A",
      decision: "allow",
      reason: "ok",
      sessionId: "s1",
    });
    linkLog.record({
      sha: "aaa",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    runLog.record({
      id: "task-1",
      triggerSource: "cron:nightly",
      status: "done",
      createdAt: now - 1_000,
      doneAt: now,
    });

    const lines = await buildRecentTracesDigest({
      activityLog,
      commitIssueLinkLog: linkLog,
      recipeRunLog: runLog,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("•"); // approval icon
    expect(joined).toContain("⇄"); // enrichment icon
    expect(joined).toContain("▸"); // recipe_run icon
  });

  it("honors windowMs — traces older than window are excluded", async () => {
    const now = 10 * 60 * 60 * 1000; // 10h in epoch
    // Record a trace that will appear at "now - 15h" — outside 12h window
    linkLog.record({
      sha: "old",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    // Simulate the link being 15h old by overriding the recorded `createdAt`
    // via in-memory mutation (simplest route; query uses the field directly).
    (linkLog as any).links[0].createdAt = now - 15 * 60 * 60 * 1000;

    const lines = await buildRecentTracesDigest(
      { commitIssueLinkLog: linkLog },
      { now },
    );
    expect(lines).toEqual([]);
  });

  it("caps at topN entries", async () => {
    for (let i = 0; i < 10; i += 1) {
      linkLog.record({
        sha: `sha${i}`,
        ref: "#1",
        linkType: "closes",
        resolved: true,
        workspace: "/ws",
      });
    }
    const lines = await buildRecentTracesDigest(
      { commitIssueLinkLog: linkLog },
      { topN: 3 },
    );
    // 1 heading + 3 bullets
    expect(lines.length).toBe(4);
  });

  it("truncates summaries over 80 chars", async () => {
    const now = Date.now();
    runLog.record({
      id: "task-long",
      triggerSource: "recipe:very-long-recipe-name-that-exceeds-expectations",
      status: "error",
      createdAt: now - 1_000,
      doneAt: now,
      errorMessage: "x".repeat(200),
    });
    const lines = await buildRecentTracesDigest({ recipeRunLog: runLog });
    const bullet = lines[1] ?? "";
    expect(bullet).toContain("…"); // truncation marker present
    // The rendered summary (between icon and "— Ns ago") must be ≤80 chars.
    const summaryMatch = bullet.match(/^ {2}. (.+) — \d+[smhd] ago$/);
    expect(summaryMatch).not.toBeNull();
    expect((summaryMatch?.[1] ?? "").length).toBeLessThanOrEqual(80);
  });

  it("formats relative times correctly", async () => {
    const now = 1_000_000_000_000;
    linkLog.record({
      sha: "a",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    (linkLog as any).links[0].createdAt = now - 2 * 60 * 60 * 1000;

    const lines = await buildRecentTracesDigest(
      { commitIssueLinkLog: linkLog },
      { now },
    );
    expect(lines[1]).toContain("2h ago");
  });

  it("orders newest-first", async () => {
    const now = 1_000_000_000_000;
    linkLog.record({
      sha: "older",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    linkLog.record({
      sha: "newer",
      ref: "#2",
      linkType: "closes",
      resolved: true,
      workspace: "/ws",
    });
    (linkLog as any).links[0].createdAt = now - 3 * 60 * 60 * 1000;
    (linkLog as any).links[1].createdAt = now - 1 * 60 * 60 * 1000;

    const lines = await buildRecentTracesDigest(
      { commitIssueLinkLog: linkLog },
      { now },
    );
    expect(lines[1]).toContain("#2");
    expect(lines[2]).toContain("#1");
  });

  it("enforces hard byte cap", async () => {
    // Record enough traces to exceed 2KB when formatted
    for (let i = 0; i < 50; i += 1) {
      linkLog.record({
        sha: `sha${i.toString().padStart(40, "0")}`,
        ref: `#${i}`,
        linkType: "closes",
        resolved: true,
        workspace: "/ws",
        subject: "x".repeat(70),
      });
    }
    const lines = await buildRecentTracesDigest(
      { commitIssueLinkLog: linkLog },
      { topN: 50 },
    );
    expect(lines.join("\n").length).toBeLessThanOrEqual(2_048);
  });
});

describe("buildRecentTracesDigest — decision formatting", () => {
  it("surfaces ref + tags + solution for decision traces", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "PR-42",
      problem: "token leak in git remote URL",
      solution: "env -u GITHUB_TOKEN for all gh invocations",
      workspace: "/ws",
      tags: ["security", "gh"],
    });
    const lines = await buildRecentTracesDigest({
      decisionTraceLog: decisionLog,
    });
    expect(lines[1]).toContain("★");
    expect(lines[1]).toContain("PR-42");
    expect(lines[1]).toContain("[security,gh]");
    expect(lines[1]).toContain("env -u GITHUB_TOKEN");
    // Must not double-print the ref (old format was "<ref> — <solution>")
    expect(lines[1]?.match(/PR-42/g)?.length).toBe(1);
  });

  it("omits tag bracket when trace has no tags", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#99",
      problem: "p",
      solution: "s",
      workspace: "/ws",
    });
    const lines = await buildRecentTracesDigest({
      decisionTraceLog: decisionLog,
    });
    expect(lines[1]).toContain("#99");
    expect(lines[1]).not.toContain("[");
  });

  it("caps tags shown at 3 to protect budget", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#1",
      problem: "p",
      solution: "s",
      workspace: "/ws",
      tags: ["a", "b", "c", "d", "e"],
    });
    const lines = await buildRecentTracesDigest({
      decisionTraceLog: decisionLog,
    });
    expect(lines[1]).toContain("[a,b,c]");
    expect(lines[1]).not.toContain("d");
  });

  it("keeps the full 80-char summary budget including ref+tags", async () => {
    const decisionLog = new DecisionTraceLog({ dir });
    decisionLog.record({
      ref: "#long",
      problem: "p",
      solution: "x".repeat(200),
      workspace: "/ws",
      tags: ["tag"],
    });
    const lines = await buildRecentTracesDigest({
      decisionTraceLog: decisionLog,
    });
    const bullet = lines[1] ?? "";
    expect(bullet).toContain("…");
    const summaryMatch = bullet.match(/^ {2}. (.+) — \d+[smhd] ago$/);
    expect(summaryMatch).not.toBeNull();
    expect((summaryMatch?.[1] ?? "").length).toBeLessThanOrEqual(80);
  });
});
