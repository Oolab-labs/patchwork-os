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
