import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RecipeRun, RecipeRunLog } from "../runLog.js";
import { decodeRunCursor, encodeRunCursor } from "../runPage.js";

/**
 * Older-than paging over the run log (`RecipeRunLog.queryPage`).
 *
 * `query()` only ever sees the in-memory ring (500 by default), so a list that
 * wants to page past it has nowhere to go. `queryPage` reads the durable files
 * (`runs.jsonl.1` + `runs.jsonl`) and walks them with a `(createdAt, runKey)`
 * cursor — NOT `seq`, which is per-instance and collides across the processes
 * sharing the file (#1324).
 */

type Run = Omit<RecipeRun, "seq">;

function run(i: number, over: Partial<Run> = {}): Run {
  return {
    taskId: `t-${String(i).padStart(4, "0")}`,
    recipeName: i % 2 === 0 ? "even" : "odd",
    trigger: i % 3 === 0 ? "cron" : "recipe",
    status: i % 5 === 0 ? "error" : "done",
    createdAt: 10_000 + i,
    doneAt: 10_000 + i,
    durationMs: 1,
    stepResults: [{ id: "s", tool: "file.write", status: "ok", durationMs: 1 }],
    ...over,
  };
}

/** Walk every page; return the taskIds in served order. */
function walk(
  log: RecipeRunLog,
  q: Omit<Parameters<RecipeRunLog["queryPage"]>[0], "before">,
): string[] {
  const out: string[] = [];
  let before: ReturnType<typeof decodeRunCursor> = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = log.queryPage({ ...q, before });
    for (const r of page.runs) out.push(String(r.taskId));
    if (page.nextBefore === null) return out;
    const next = decodeRunCursor(page.nextBefore);
    expect(next, "nextBefore must decode").not.toBeNull();
    before = next;
  }
  throw new Error("paging did not terminate");
}

describe("RecipeRunLog.queryPage — older-than cursor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "runlog-page-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pages past the in-memory ring: contiguous, newest-first, no duplicates", () => {
    const log = new RecipeRunLog({ dir, memoryCap: 5 });
    for (let i = 0; i < 40; i++) log.appendDirect(run(i));
    // The ring holds 5; the legacy query cannot see further.
    expect(log.query({ limit: 500 })).toHaveLength(5);

    const ids = walk(log, { limit: 7 });
    const expected = Array.from({ length: 40 }, (_, i) => run(39 - i).taskId);
    expect(ids).toEqual(expected);
  });

  it("reads the rotation archive as well as the live file", () => {
    const log = new RecipeRunLog({
      dir,
      memoryCap: 3,
      maxPersistBytes: 4_000,
      maxArchiveBytes: 1_000_000,
    });
    for (let i = 0; i < 60; i++) log.appendDirect(run(i));
    expect(
      existsSync(path.join(dir, "runs.jsonl.1")),
      "rotation must have fired for this test to mean anything",
    ).toBe(true);

    const ids = walk(log, { limit: 9 });
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids[0]).toBe(run(59).taskId);
    expect(ids[59]).toBe(run(0).taskId);
  });

  it("an exhausted walk returns nextBefore null, including on an exact boundary", () => {
    const log = new RecipeRunLog({ dir, memoryCap: 2 });
    for (let i = 0; i < 6; i++) log.appendDirect(run(i));
    const first = log.queryPage({ before: null, limit: 3 });
    expect(first.runs).toHaveLength(3);
    expect(first.nextBefore).not.toBeNull();
    const second = log.queryPage({
      before: decodeRunCursor(first.nextBefore as string),
      limit: 3,
    });
    expect(second.runs.map((r) => r.taskId)).toEqual([
      run(2).taskId,
      run(1).taskId,
      run(0).taskId,
    ]);
    // Exactly 3 remained: no phantom "more" page.
    expect(second.nextBefore).toBeNull();
  });

  it("an empty log returns no rows and nextBefore null", () => {
    const log = new RecipeRunLog({ dir });
    expect(log.queryPage({ before: null })).toEqual({
      runs: [],
      nextBefore: null,
    });
  });

  it("applies recipe / status / trigger filters across the in-memory boundary", () => {
    const log = new RecipeRunLog({ dir, memoryCap: 4 });
    for (let i = 0; i < 50; i++) log.appendDirect(run(i));
    const all = Array.from({ length: 50 }, (_, i) => run(49 - i));

    expect(walk(log, { limit: 4, recipe: "even" })).toEqual(
      all.filter((r) => r.recipeName === "even").map((r) => r.taskId),
    );
    expect(walk(log, { limit: 3, status: "error" })).toEqual(
      all.filter((r) => r.status === "error").map((r) => r.taskId),
    );
    expect(walk(log, { limit: 5, trigger: "cron" })).toEqual(
      all.filter((r) => r.trigger === "cron").map((r) => r.taskId),
    );
  });

  it("two instances sharing the file (colliding seqs) are both paged, once each", () => {
    const a = new RecipeRunLog({ dir, memoryCap: 3 });
    const b = new RecipeRunLog({ dir, memoryCap: 3 });
    for (let i = 0; i < 20; i++) {
      // Both mint seq 1, 2, 3 … independently — the #1324 collision.
      a.appendDirect(run(i, { taskId: `a-${i}`, createdAt: 50_000 + 2 * i }));
      b.appendDirect(
        run(i, { taskId: `b-${i}`, createdAt: 50_000 + 2 * i + 1 }),
      );
    }
    const ids = walk(a, { limit: 6 });
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it("equal createdAt is ordered by run key, so a page boundary between ties loses nothing", () => {
    const log = new RecipeRunLog({ dir, memoryCap: 2 });
    for (let i = 0; i < 9; i++) {
      log.appendDirect(run(i, { createdAt: 77 }));
    }
    const ids = walk(log, { limit: 2 });
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
  });

  it("a run written twice (running, then terminal) appears once with its final status", () => {
    const log = new RecipeRunLog({ dir, memoryCap: 1 });
    const seq = log.startRun({
      taskId: "lifecycle",
      recipeName: "r",
      trigger: "recipe",
      createdAt: 5,
    });
    log.completeRun(seq, {
      status: "done",
      doneAt: 6,
      durationMs: 1,
      stepResults: [],
    });
    for (let i = 0; i < 5; i++) log.appendDirect(run(i));
    const page = log.queryPage({ before: null, limit: 100 });
    const rows = page.runs.filter((r) => r.taskId === "lifecycle");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
    // And a status filter judges the FINAL row, not the first one written.
    expect(
      log
        .queryPage({ before: null, status: "running" })
        .runs.some((r) => r.taskId === "lifecycle"),
    ).toBe(false);
  });

  it("fields: summary omits stepResults and reports stepCount; the default keeps them", () => {
    const log = new RecipeRunLog({ dir });
    log.appendDirect(run(1));
    const full = log.queryPage({ before: null });
    expect(full.runs[0]?.stepResults).toHaveLength(1);
    const summary = log.queryPage({ before: null, fields: "summary" });
    expect(summary.runs[0]).not.toHaveProperty("stepResults");
    expect(summary.runs[0]?.stepCount).toBe(1);
  });
});

describe("run cursor encoding", () => {
  it("round-trips", () => {
    const c = { createdAt: 1_700_000_000_123, key: "task:abc:1" };
    expect(decodeRunCursor(encodeRunCursor(c))).toEqual(c);
  });

  it.each([
    "",
    "garbage",
    "v1.",
    "v1.!!!",
    `v1.${Buffer.from("{}").toString("base64url")}`,
    `v1.${Buffer.from('["x","task:a"]').toString("base64url")}`,
    `v1.${Buffer.from('[1,""]').toString("base64url")}`,
    `v2.${Buffer.from('[1,"task:a"]').toString("base64url")}`,
    `v1.${"A".repeat(5000)}`,
  ])("rejects %j", (raw) => {
    expect(decodeRunCursor(raw)).toBeNull();
  });
});
