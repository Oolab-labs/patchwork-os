/**
 * Acceptance 8 + 9: two unrelated runs cannot evict each other's pre-images,
 * and rollback by RUN identity restores exactly that run and no neighbour.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planRecipeRollbackByRun,
  runRecipeRollbackByRun,
} from "../../commands/recipe.js";
import { FileRollbackLog } from "../fileRollback.js";
import { deriveScopeKey } from "../idempotencyKey.js";
import { prepareAttemptLedger, recordAttemptRun } from "../runLedgers.js";

let root: string;
let work: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "rb-run-root-"));
  work = mkdtempSync(path.join(os.tmpdir(), "rb-run-work-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** Simulate one automated run: its own store, a capture, then the write. */
function run(taskId: string, attempt: string, file: string, content: string) {
  const dir = prepareAttemptLedger(root, "r", attempt) as string;
  recordAttemptRun(dir, {
    runTaskId: taskId,
    recipeName: "r",
    attemptId: attempt,
  });
  const log = new FileRollbackLog({
    dir,
    scopeKey: deriveScopeKey("r", attempt),
  });
  expect(log.capturePreImage(file).persisted).toBe(true);
  writeFileSync(file, content);
}

describe("rollback by run identity", () => {
  it("restores exactly that run's writes and leaves a neighbouring run alone", () => {
    const a = path.join(work, "a.md");
    const b = path.join(work, "b.md");
    writeFileSync(a, "a-original");
    writeFileSync(b, "b-original");
    run("task-A", "cron-1", a, "a-by-run-A");
    run("task-B", "cron-2", b, "b-by-run-B");

    const res = runRecipeRollbackByRun("r", "task-A", { root });
    expect(res.restored).toEqual([a]);
    expect(readFileSync(a, "utf-8")).toBe("a-original");
    expect(readFileSync(b, "utf-8")).toBe("b-by-run-B"); // untouched
  });

  it("a created file is deleted on rollback (confirmed-absent)", () => {
    const c = path.join(work, "created.md");
    run("task-C", "once-x", c, "new");
    const plan = planRecipeRollbackByRun("r", "task-C", { root });
    expect(plan.remove).toEqual([c]);
    runRecipeRollbackByRun("r", "task-C", { root });
    expect(existsSync(c)).toBe(false);
  });

  it("the plan lists what would change without changing anything", () => {
    const a = path.join(work, "a.md");
    writeFileSync(a, "orig");
    run("task-P", "cron-9", a, "changed");
    const plan = planRecipeRollbackByRun("r", "task-P", { root });
    expect(plan.restore).toEqual([a]);
    expect(readFileSync(a, "utf-8")).toBe("changed");
  });

  it("an unknown or expired run says rollback is no longer available", () => {
    expect(() => runRecipeRollbackByRun("r", "task-gone", { root })).toThrow(
      /no rollback store.*task-gone/,
    );
  });

  it("refuses a run that belongs to a different recipe", () => {
    const a = path.join(work, "a.md");
    writeFileSync(a, "orig");
    run("task-R", "cron-3", a, "x");
    expect(() =>
      runRecipeRollbackByRun("other-recipe", "task-R", { root }),
    ).toThrow(/belongs to recipe "r"/);
  });
});
