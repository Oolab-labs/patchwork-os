import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../runLog.js";

describe("RecipeRunLog.parseTrigger", () => {
  it("parses cron/webhook/recipe prefixes", () => {
    expect(RecipeRunLog.parseTrigger("cron:nightly")).toEqual({
      trigger: "cron",
      recipeName: "nightly",
    });
    expect(RecipeRunLog.parseTrigger("webhook:deploy")).toEqual({
      trigger: "webhook",
      recipeName: "deploy",
    });
    expect(RecipeRunLog.parseTrigger("recipe:review")).toEqual({
      trigger: "recipe",
      recipeName: "review",
    });
  });

  it("ignores non-recipe trigger sources", () => {
    expect(RecipeRunLog.parseTrigger("onFileSave")).toBeNull();
    expect(RecipeRunLog.parseTrigger(undefined)).toBeNull();
    expect(RecipeRunLog.parseTrigger("")).toBeNull();
    expect(RecipeRunLog.parseTrigger("cron:")).toBeNull();
  });

  it("preserves colons inside recipe names", () => {
    expect(RecipeRunLog.parseTrigger("recipe:foo:bar")).toEqual({
      trigger: "recipe",
      recipeName: "foo:bar",
    });
  });
});

describe("RecipeRunLog.record", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-runlog-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("records recipe-triggered terminal tasks and skips others", () => {
    const log = new RecipeRunLog({ dir: tmp });
    const rec = log.record({
      id: "task-1",
      triggerSource: "cron:nightly",
      status: "done",
      createdAt: 1_000,
      startedAt: 1_100,
      doneAt: 1_500,
      model: "sonnet-4-6",
      output: "RECIPE DONE: ok",
    });
    expect(rec).not.toBeNull();
    expect(rec!.trigger).toBe("cron");
    expect(rec!.recipeName).toBe("nightly");
    expect(rec!.durationMs).toBe(400);
    expect(rec!.outputTail).toContain("RECIPE DONE");
    expect(log.size()).toBe(1);

    // Non-recipe trigger is skipped.
    const skip = log.record({
      id: "task-2",
      triggerSource: "onFileSave",
      status: "done",
      createdAt: 2_000,
      doneAt: 2_100,
    });
    expect(skip).toBeNull();
    expect(log.size()).toBe(1);

    // Non-terminal status is skipped.
    const skip2 = log.record({
      id: "task-3",
      triggerSource: "recipe:review",
      status: "running",
      createdAt: 3_000,
    });
    expect(skip2).toBeNull();
  });

  it("persists to JSONL and reloads on construction", () => {
    const log1 = new RecipeRunLog({ dir: tmp });
    log1.record({
      id: "a",
      triggerSource: "webhook:deploy",
      status: "done",
      createdAt: 100,
      startedAt: 150,
      doneAt: 200,
    });
    log1.record({
      id: "b",
      triggerSource: "recipe:review",
      status: "error",
      createdAt: 300,
      doneAt: 400,
      errorMessage: "boom",
    });
    const file = path.join(tmp, "runs.jsonl");
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).taskId).toBe("a");

    // New instance should see the history.
    const log2 = new RecipeRunLog({ dir: tmp });
    expect(log2.size()).toBe(2);
    const q = log2.query({ status: "error" });
    expect(q).toHaveLength(1);
    expect(q[0]!.taskId).toBe("b");
  });

  it("filters by trigger, status, recipe, and after-seq", () => {
    const log = new RecipeRunLog({ dir: tmp });
    log.record({
      id: "a",
      triggerSource: "cron:nightly",
      status: "done",
      createdAt: 100,
      doneAt: 200,
    });
    log.record({
      id: "b",
      triggerSource: "webhook:deploy",
      status: "done",
      createdAt: 300,
      doneAt: 400,
    });
    log.record({
      id: "c",
      triggerSource: "cron:nightly",
      status: "error",
      createdAt: 500,
      doneAt: 600,
      errorMessage: "x",
    });

    expect(log.query({ trigger: "cron" }).map((r) => r.taskId)).toEqual([
      "c",
      "a",
    ]);
    expect(log.query({ status: "error" }).map((r) => r.taskId)).toEqual(["c"]);
    expect(log.query({ recipe: "nightly" })).toHaveLength(2);
    expect(log.query({ after: 2 }).map((r) => r.taskId)).toEqual(["c"]);
    // Newest first by default.
    expect(log.query().map((r) => r.taskId)).toEqual(["c", "b", "a"]);
  });

  it("caps in-memory ring but keeps file intact", () => {
    const log = new RecipeRunLog({ dir: tmp, memoryCap: 2 });
    for (let i = 0; i < 5; i++) {
      log.record({
        id: `t${i}`,
        triggerSource: "recipe:x",
        status: "done",
        createdAt: i * 100,
        doneAt: i * 100 + 50,
      });
    }
    expect(log.size()).toBe(2);
    const lines = readFileSync(path.join(tmp, "runs.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(5);
  });

  it("appendDirect persists CLI-run shaped payloads and makes them queryable", () => {
    const log = new RecipeRunLog({ dir: tmp });
    const now = Date.now();
    log.appendDirect({
      taskId: `cli-${now}`,
      recipeName: "project-health-check",
      trigger: "recipe",
      status: "done",
      createdAt: now,
      startedAt: now,
      doneAt: now + 1200,
      durationMs: 1200,
      stepResults: [
        { id: "commits", status: "ok", durationMs: 234 },
        { id: "summarize", status: "ok", durationMs: 890 },
        { id: "write", status: "ok", durationMs: 12 },
      ],
    });
    expect(log.size()).toBe(1);
    const runs = log.query({ recipe: "project-health-check" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.stepResults).toHaveLength(3);
    expect(runs[0]!.stepResults![0]!.id).toBe("commits");
    // Verify it hit disk
    const lines = readFileSync(path.join(tmp, "runs.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.recipeName).toBe("project-health-check");
    expect(parsed.stepResults).toHaveLength(3);
  });

  it("getBySeq finds runs evicted from the in-memory ring (DB-3 read-on-miss)", () => {
    // Append more runs than the ring cap can hold. The first ones get
    // evicted from memory but stay on disk in runs.jsonl. getBySeq must
    // still find them — without this, the dashboard's run-detail page
    // 404s every recipe older than the latest 500.
    const log = new RecipeRunLog({ dir: tmp, memoryCap: 3 });
    for (let i = 0; i < 8; i++) {
      log.record({
        id: `t${i}`,
        triggerSource: "recipe:foo",
        status: "done",
        createdAt: i * 100,
        doneAt: i * 100 + 10,
      });
    }
    expect(log.size()).toBe(3); // ring evicted 5 older runs

    // Latest seqs (still in memory) — fast path
    expect(log.getBySeq(8)?.taskId).toBe("t7");
    expect(log.getBySeq(7)?.taskId).toBe("t6");

    // Older seqs (evicted from ring, must come from disk)
    expect(log.getBySeq(1)?.taskId).toBe("t0");
    expect(log.getBySeq(2)?.taskId).toBe("t1");
    expect(log.getBySeq(3)?.taskId).toBe("t2");

    // Unknown seqs still return null
    expect(log.getBySeq(99)).toBeNull();
    expect(log.getBySeq(0)).toBeNull();
  });

  it("getBySeq read-on-miss handles malformed lines without throwing", () => {
    // Seed a file with one valid run (seq=1) plus a malformed line, then
    // ask for a seq that's not in the in-memory ring (we'll use a fresh
    // log that won't load from disk by default — but constructor's
    // loadExisting reads everything anyway). Use a non-existent seq to
    // force the on-miss disk scan to run, prove it doesn't blow up on
    // the malformed line.
    const file = path.join(tmp, "runs.jsonl");
    const valid = {
      seq: 1,
      taskId: "v",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
    };
    require("node:fs").writeFileSync(
      file,
      `${JSON.stringify(valid)}\nnot-json\n`,
    );
    const log = new RecipeRunLog({ dir: tmp });
    expect(log.getBySeq(99)).toBeNull(); // non-existent seq, must not throw
  });

  // ── VD-0: running-state run entries ──────────────────────────────────────
  // Recipe runs are now visible while in flight. `startRun` allocates a seq
  // and adds a `status:"running"` entry to the in-memory ring (no disk write,
  // since running entries are ephemeral and don't survive bridge restart).
  // `completeRun` updates the entry to a terminal status and persists to
  // disk. This is the foundation for VD-1 live-tail.

  it("startRun allocates seq + adds running entry (memory only)", () => {
    const log = new RecipeRunLog({ dir: tmp });
    const seq = log.startRun({
      taskId: "chained:foo:1700000000000",
      recipeName: "foo",
      trigger: "recipe",
      createdAt: 1_000,
    });
    expect(seq).toBe(1);
    expect(log.size()).toBe(1);
    const run = log.getBySeq(seq);
    expect(run?.status).toBe("running");
    expect(run?.recipeName).toBe("foo");
    expect(run?.taskId).toBe("chained:foo:1700000000000");
    // No JSONL write yet — running entries are in-memory only.
    expect(() => readFileSync(path.join(tmp, "runs.jsonl"), "utf-8")).toThrow();
  });

  it("completeRun finalizes running entry + persists to disk", () => {
    const log = new RecipeRunLog({ dir: tmp });
    const seq = log.startRun({
      taskId: "chained:foo:1",
      recipeName: "foo",
      trigger: "recipe",
      createdAt: 1_000,
    });
    log.completeRun(seq, {
      status: "done",
      doneAt: 2_500,
      durationMs: 1_500,
      stepResults: [
        { id: "step1", status: "ok", durationMs: 800 },
        { id: "step2", status: "ok", durationMs: 700 },
      ],
    });
    const run = log.getBySeq(seq);
    expect(run?.status).toBe("done");
    expect(run?.doneAt).toBe(2_500);
    expect(run?.durationMs).toBe(1_500);
    expect(run?.stepResults).toHaveLength(2);
    // Now on disk.
    const lines = readFileSync(path.join(tmp, "runs.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.seq).toBe(seq);
    expect(parsed.status).toBe("done");
  });

  it("query() returns running entries alongside terminal ones", () => {
    const log = new RecipeRunLog({ dir: tmp });
    log.appendDirect({
      taskId: "done-1",
      recipeName: "old",
      trigger: "recipe",
      status: "done",
      createdAt: 100,
      doneAt: 200,
      durationMs: 100,
    });
    log.startRun({
      taskId: "running-1",
      recipeName: "active",
      trigger: "recipe",
      createdAt: 300,
    });
    const all = log.query();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.status)).toContain("running");
    expect(all.map((r) => r.status)).toContain("done");
  });

  it("query({status: 'running'}) filters to running runs only", () => {
    const log = new RecipeRunLog({ dir: tmp });
    log.appendDirect({
      taskId: "done-1",
      recipeName: "old",
      trigger: "recipe",
      status: "done",
      createdAt: 100,
      doneAt: 200,
      durationMs: 100,
    });
    const seq = log.startRun({
      taskId: "running-1",
      recipeName: "active",
      trigger: "recipe",
      createdAt: 300,
    });
    const running = log.query({ status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]!.seq).toBe(seq);
  });

  it("completeRun with non-existent seq is a no-op (does not throw)", () => {
    const log = new RecipeRunLog({ dir: tmp });
    expect(() =>
      log.completeRun(999, {
        status: "done",
        doneAt: 100,
        durationMs: 50,
        stepResults: [],
      }),
    ).not.toThrow();
  });

  it("updateRunSteps appends step results to a running entry incrementally", () => {
    const log = new RecipeRunLog({ dir: tmp });
    const seq = log.startRun({
      taskId: "t",
      recipeName: "r",
      trigger: "recipe",
      createdAt: 100,
    });
    log.updateRunSteps(seq, [{ id: "s1", status: "ok", durationMs: 50 }]);
    expect(log.getBySeq(seq)?.stepResults).toHaveLength(1);
    log.updateRunSteps(seq, [
      { id: "s1", status: "ok", durationMs: 50 },
      { id: "s2", status: "ok", durationMs: 75 },
    ]);
    expect(log.getBySeq(seq)?.stepResults).toHaveLength(2);
    // Still no disk write — only completeRun persists.
    expect(() => readFileSync(path.join(tmp, "runs.jsonl"), "utf-8")).toThrow();
  });

  it("VD-2: pre-VD-2 runs.jsonl rows load fine (no resolvedParams/output/registrySnapshot)", () => {
    // Simulates a runs.jsonl from a bridge that pre-dates VD-2 capture.
    // The new fields on RunStepResult are all optional; old rows must
    // round-trip without error.
    const file = path.join(tmp, "runs.jsonl");
    const oldStyleRun = {
      seq: 1,
      taskId: "old:nightly:1700000000000",
      recipeName: "nightly",
      trigger: "cron",
      status: "done",
      createdAt: 1_700_000_000_000,
      doneAt: 1_700_000_001_500,
      durationMs: 1_500,
      stepResults: [
        // No resolvedParams / output / registrySnapshot / startedAt.
        { id: "fetch", tool: "noop.tool", status: "ok", durationMs: 200 },
        { id: "summarize", tool: "noop.tool", status: "ok", durationMs: 800 },
      ],
    };
    require("node:fs").writeFileSync(file, `${JSON.stringify(oldStyleRun)}\n`);
    const log = new RecipeRunLog({ dir: tmp });
    expect(log.size()).toBe(1);
    const run = log.getBySeq(1);
    expect(run?.recipeName).toBe("nightly");
    expect(run?.stepResults).toHaveLength(2);
    expect(run?.stepResults?.[0]?.resolvedParams).toBeUndefined();
    expect(run?.stepResults?.[0]?.output).toBeUndefined();
    expect(run?.stepResults?.[0]?.registrySnapshot).toBeUndefined();
    expect(run?.stepResults?.[0]?.startedAt).toBeUndefined();
  });

  it("tolerates malformed JSONL lines on reload", () => {
    const file = path.join(tmp, "runs.jsonl");
    // Seed with one bad line and one good.
    const good = {
      seq: 1,
      taskId: "x",
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      durationMs: 1,
    };
    require("node:fs").writeFileSync(
      file,
      `not-json\n${JSON.stringify(good)}\n`,
    );
    const log = new RecipeRunLog({ dir: tmp });
    expect(log.size()).toBe(1);
    expect(log.query()[0]!.taskId).toBe("x");
  });
});
