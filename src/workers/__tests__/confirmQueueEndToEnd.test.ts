import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../../runLog.js";
import { OutcomeStore } from "../outcomeStore.js";
import {
  computePendingConfirmations,
  formatPendingConfirmations,
} from "../runWorkerShadow.js";

/**
 * End-to-end proof that the confirm loop composes: a worker performs a
 * non-reversible action whose tool returns NO url, and an operator can see it
 * and is given a command that will actually confirm it.
 *
 * Every piece of this was unit-tested in isolation (#1318-#1322) and none of it
 * was exercised together. When it finally was, against the live log, the queue
 * came back empty — not because the queue was broken but because the run had
 * been destroyed first by seq collision and then by rotation. A green unit test
 * for each part said nothing about whether the loop worked.
 */
describe("confirm queue: end to end, non-URL action", () => {
  let dir: string;
  let workersDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "confirm-e2e-"));
    workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      path.join(workersDir, "errands.worker.yaml"),
      [
        "id: errands-worker",
        "name: Errands",
        "recipe: errand",
        "autonomyCeiling: 1",
        "owns:",
        "  - tasks",
      ].join("\n"),
      "utf-8",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedFiling(taskId: string, at: number, id: string) {
    new RecipeRunLog({ dir }).appendDirect({
      taskId,
      recipeName: "errand",
      trigger: "recipe",
      status: "done",
      createdAt: at,
      doneAt: at,
      durationMs: 1,
      stepResults: [
        {
          id: "created",
          tool: "todoist.create_task",
          status: "ok",
          durationMs: 1,
          // The real shape: an id, and no url anywhere.
          output: { id, content: "Renew the road tax" },
        },
      ],
    });
  }

  it("surfaces the filing and prints a command that actually confirms it", () => {
    seedFiling("yaml:errand:1", 1000, "TASK123");

    const pending = computePendingConfirmations({
      workersDir,
      patchworkDir: dir,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.actionKey).toBe("todoist.create_task:TASK123");
    expect(pending[0]?.ref).toEqual({
      tool: "todoist.create_task",
      id: "TASK123",
    });
    expect(pending[0]?.issueUrl).toBeUndefined(); // no permalink exists

    // The operator-facing text must contain a runnable command — the id is an
    // opaque connector string nobody can retype from memory.
    const out = formatPendingConfirmations(pending, 2000);
    expect(out).toContain("--tool todoist.create_task --id TASK123");

    // ...and running that command's effect must actually clear the queue.
    new OutcomeStore(dir).upsert({
      ref: { tool: "todoist.create_task", id: "TASK123" },
      disposition: "confirmed",
      checkedAt: 2000,
      origin: "manual",
    });
    expect(
      computePendingConfirmations({ workersDir, patchworkDir: dir }),
    ).toHaveLength(0);
  });

  it("a rejected filing also leaves the queue (it is actioned, not pending)", () => {
    seedFiling("yaml:errand:2", 1000, "TASK456");
    expect(
      computePendingConfirmations({ workersDir, patchworkDir: dir }),
    ).toHaveLength(1);
    new OutcomeStore(dir).upsert({
      ref: { tool: "todoist.create_task", id: "TASK456" },
      disposition: "junk",
      checkedAt: 2000,
      origin: "manual",
    });
    expect(
      computePendingConfirmations({ workersDir, patchworkDir: dir }),
    ).toHaveLength(0);
  });

  it("two filings sharing a seq BOTH reach the queue (the collision regression)", () => {
    // Both logs are constructed BEFORE either appends. That is what reproduces
    // the real failure: each instance seeds its counter from the file at
    // construction time, so two live instances hand the same seq to unrelated
    // runs. Constructing them sequentially instead yields seqs 1 and 2 — no
    // collision, and the test would pass without exercising the bug at all.
    const a = new RecipeRunLog({ dir });
    const b = new RecipeRunLog({ dir });
    const filing = (taskId: string, at: number, id: string) => ({
      taskId,
      recipeName: "errand",
      trigger: "recipe" as const,
      status: "done" as const,
      createdAt: at,
      doneAt: at,
      durationMs: 1,
      stepResults: [
        {
          id: "created",
          tool: "todoist.create_task",
          status: "ok" as const,
          durationMs: 1,
          output: { id },
        },
      ],
    });
    a.appendDirect(filing("yaml:errand:a", 1000, "AAA"));
    b.appendDirect(filing("yaml:errand:b", 2000, "BBB"));

    // Anchor: prove the seqs really did collide, so this test cannot silently
    // stop covering the regression it is named for.
    const seqs = new RecipeRunLog({ dir })
      .query({ limit: 500 })
      .map((r) => r.seq);
    expect(new Set(seqs).size, "the two runs must share a seq").toBe(1);

    const keys = computePendingConfirmations({ workersDir, patchworkDir: dir })
      .map((p) => p.actionKey)
      .sort();
    expect(keys).toEqual([
      "todoist.create_task:AAA",
      "todoist.create_task:BBB",
    ]);
  });
});
