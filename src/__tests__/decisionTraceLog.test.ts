import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionTraceLog } from "../decisionTraceLog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "decision-trace-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function base() {
  return {
    ref: "#42",
    problem: "auth times out on cold start",
    solution: "lazy-init the token cache",
    workspace: "/ws",
  };
}

describe("DecisionTraceLog", () => {
  it("records and assigns monotonic seq", () => {
    const log = new DecisionTraceLog({ dir });
    expect(log.record(base()).seq).toBe(1);
    expect(log.record({ ...base(), ref: "#43" }).seq).toBe(2);
    expect(log.size()).toBe(2);
  });

  it("rejects missing required fields", () => {
    const log = new DecisionTraceLog({ dir });
    expect(() => log.record({ ...base(), ref: "" })).toThrow(/ref/);
    expect(() => log.record({ ...base(), problem: "" })).toThrow(/problem/);
    expect(() => log.record({ ...base(), solution: "" })).toThrow(/solution/);
  });

  it("clips over-length problem and solution", () => {
    const log = new DecisionTraceLog({ dir });
    expect(() => log.record({ ...base(), problem: "x".repeat(600) })).toThrow(
      /problem exceeds/,
    );
    expect(() => log.record({ ...base(), solution: "y".repeat(600) })).toThrow(
      /solution exceeds/,
    );
  });

  it("caps tags at 10 entries, each ≤32 chars", () => {
    const log = new DecisionTraceLog({ dir });
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const result = log.record({ ...base(), tags });
    expect(result.tags).toHaveLength(10);
    const longTag = "x".repeat(33);
    const result2 = log.record({ ...base(), ref: "#2", tags: [longTag] });
    expect(result2.tags).toBeUndefined();
  });

  it("filters by ref (substring + exact)", () => {
    const log = new DecisionTraceLog({ dir });
    log.record({ ...base(), ref: "#42" });
    log.record({ ...base(), ref: "PR-42" });
    log.record({ ...base(), ref: "abc123" });
    expect(log.query({ ref: "42" })).toHaveLength(2);
    expect(log.query({ ref: "#42" })).toHaveLength(1);
    expect(log.query({ ref: "abc" })).toHaveLength(1);
  });

  it("filters by tag", () => {
    const log = new DecisionTraceLog({ dir });
    log.record({ ...base(), ref: "#1", tags: ["perf"] });
    log.record({ ...base(), ref: "#2", tags: ["security"] });
    log.record({ ...base(), ref: "#3", tags: ["perf", "db"] });
    expect(log.query({ tag: "perf" })).toHaveLength(2);
    expect(log.query({ tag: "db" })).toHaveLength(1);
  });

  it("filters by workspace, sessionId, since", () => {
    let t = 1_000;
    const log = new DecisionTraceLog({ dir, now: () => t });
    log.record({ ...base(), ref: "#1", workspace: "/a" });
    t = 2_000;
    log.record({ ...base(), ref: "#2", workspace: "/b", sessionId: "s1" });
    t = 3_000;
    log.record({ ...base(), ref: "#3", workspace: "/a", sessionId: "s2" });
    expect(log.query({ workspace: "/a" })).toHaveLength(2);
    expect(log.query({ sessionId: "s1" })).toHaveLength(1);
    expect(log.query({ since: 2_500 })).toHaveLength(1);
  });

  it("returns newest-first", () => {
    let t = 1_000;
    const log = new DecisionTraceLog({ dir, now: () => t });
    log.record({ ...base(), ref: "#1" });
    t = 2_000;
    log.record({ ...base(), ref: "#2" });
    const rows = log.query();
    expect(rows[0]?.ref).toBe("#2");
    expect(rows[1]?.ref).toBe("#1");
  });

  it("persists to JSONL + reloads into fresh instance", () => {
    const log1 = new DecisionTraceLog({ dir });
    log1.record(base());
    log1.record({ ...base(), ref: "#43" });
    const raw = readFileSync(path.join(dir, "decision_traces.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    const log2 = new DecisionTraceLog({ dir });
    expect(log2.size()).toBe(2);
    // seq must continue, not restart
    const next = log2.record({ ...base(), ref: "#44" });
    expect(next.seq).toBe(3);
  });

  it("skips malformed JSONL lines on load", () => {
    const log1 = new DecisionTraceLog({ dir });
    log1.record(base());
    const file = path.join(dir, "decision_traces.jsonl");
    const good = readFileSync(file, "utf-8");
    const fs = require("node:fs");
    fs.writeFileSync(file, `not json\n${good}{"no-required":true}\n`);
    const log2 = new DecisionTraceLog({ dir });
    expect(log2.size()).toBe(1);
  });

  it("enforces memoryCap by trimming oldest", () => {
    const log = new DecisionTraceLog({ dir, memoryCap: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.record({ ...base(), ref: `#${i}` });
    }
    expect(log.size()).toBe(3);
    expect(log.query({}).map((r) => r.ref)).toEqual(["#4", "#3", "#2"]);
  });

  it("Bug 4: rotateDisk() drops a single oversized line rather than writing past the byte cap", () => {
    // Same shape as runLog Bug 4 — the while-loop halves `lines` until under
    // cap, but exits when `lines.length === 1`. A single forged row (e.g. a
    // pre-existing decision trace with embedded blob) exceeding the cap was
    // written back unchanged.
    const file = path.join(dir, "decision_traces.jsonl");
    const fs = require("node:fs") as typeof import("node:fs");

    // Decision traces themselves cap problem/solution at 500 chars, but
    // pre-existing lines on disk aren't re-validated. Forge an arbitrarily
    // large line that satisfies the JSON shape.
    const oversized = JSON.stringify({
      seq: 1,
      createdAt: 1,
      ref: "#huge",
      problem: "p",
      solution: "s",
      workspace: "/ws",
      // 2 MB junk in tags, just to blow the cap.
      tags: ["x".repeat(2 * 1024 * 1024)],
    });
    fs.writeFileSync(file, `${oversized}\n`);
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);

    const log = new DecisionTraceLog({ dir });
    // Trigger rotation by appending a fresh trace.
    log.record({ ...base(), ref: "#after-drop" });

    const sizeAfter = fs.statSync(file).size;
    expect(sizeAfter).toBeLessThan(1024 * 1024);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain('"ref":"#huge"');
    expect(text).toContain('"ref":"#after-drop"');
  });
});
