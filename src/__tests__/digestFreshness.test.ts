import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionTraceLog } from "../decisionTraceLog.js";
import { buildRecentTracesDigest } from "../tools/recentTracesDigest.js";

/**
 * Regression: bridge.ts called refreshRecentTracesDigest() (fire-and-forget)
 * and then immediately called setInstructions(buildInstructions()) on the
 * next synchronous line. The promise hadn't resolved, so the digest was
 * whatever was cached from the previous connect — empty on first connect.
 *
 * The bridge test harness is heavy; this test asserts the underlying
 * invariant the fix must preserve: given existing decision traces on disk,
 * a freshly built digest must render them.
 */
describe("recentTracesDigest freshness", () => {
  let dir: string;
  let log: DecisionTraceLog;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "digest-freshness-"));
    log = new DecisionTraceLog({ dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reflects a trace recorded just before the build call", async () => {
    log.record({
      ref: "PR-99",
      problem: "freshness test",
      solution: "fixed via await",
      workspace: "/tmp/ws",
    });

    const lines = await buildRecentTracesDigest({ decisionTraceLog: log });

    expect(lines[0]).toBe("RECENT DECISIONS (last 12h):");
    expect(lines.some((l) => l.includes("PR-99"))).toBe(true);
  });

  it("second simulated session sees the first session's write", async () => {
    // Session 1: records a trace.
    log.record({
      ref: "decision-from-s1",
      problem: "p",
      solution: "s",
      workspace: "/tmp/ws",
    });

    // Session 2: builds a digest. Must include the earlier row.
    const lines = await buildRecentTracesDigest({ decisionTraceLog: log });
    expect(lines.some((l) => l.includes("decision-from-s1"))).toBe(true);
  });
});
