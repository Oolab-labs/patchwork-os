import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeRunLog } from "../runLog.js";

/**
 * `runs.jsonl` is not just a log — it is the autonomy gate's trust ledger.
 * Rotation trimmed the oldest rows and DELETED them, in-memory state was
 * unaffected, and nothing warned. The loss was therefore invisible at runtime.
 *
 * That is not theoretical: on 2026-08-11 rotation fired and destroyed the first
 * successful governed errand — the run the whole confirm loop was being
 * verified against — between one read of the file and the next.
 *
 * The durable mitigation (`worker_trust/` checkpoints, #1307) has never written
 * a file, so nothing stood behind it.
 */
describe("rotation must not silently destroy trust evidence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "runlog-rot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Append runs until the file exceeds the 1 MB cap and rotation fires. */
  function fillPastCap(log: RecipeRunLog, n: number) {
    const filler = "x".repeat(4000); // fat rows so we cross 1 MB quickly
    for (let i = 0; i < n; i++) {
      log.appendDirect({
        taskId: `yaml:r:${i}`,
        recipeName: "r",
        trigger: "recipe",
        status: "done",
        createdAt: 1000 + i,
        doneAt: 1000 + i,
        durationMs: 1,
        stepResults: [
          {
            id: `s${i}`,
            tool: "todoist.create_task",
            status: "ok",
            durationMs: 1,
            output: { id: `ID${i}`, note: filler },
          },
        ],
      });
    }
  }

  it("moves trimmed rows to an archive instead of deleting them", () => {
    const log = new RecipeRunLog({ dir });
    fillPastCap(log, 400);

    const main = path.join(dir, "runs.jsonl");
    const archive = path.join(dir, "runs.jsonl.1");
    expect(readFileSync(main, "utf-8").length).toBeLessThanOrEqual(1024 * 1024);
    expect(existsSync(archive), "trimmed rows were archived, not dropped").toBe(
      true,
    );

    // Every run must be present in main + archive combined. Nothing vanishes.
    const ids = new Set<string>();
    for (const f of [main, archive]) {
      for (const line of readFileSync(f, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          ids.add((JSON.parse(t) as { taskId: string }).taskId);
        } catch {
          /* ignore */
        }
      }
    }
    for (let i = 0; i < 400; i++) {
      expect(ids.has(`yaml:r:${i}`), `run ${i} survived rotation`).toBe(true);
    }
  });

  it("warns loudly, naming how many rows moved", () => {
    const warnings: string[] = [];
    const log = new RecipeRunLog({
      dir,
      logger: { warn: (m: string) => warnings.push(m) } as never,
    });
    fillPastCap(log, 400);
    const rotate = warnings.filter((w) => w.includes("rotate"));
    expect(rotate.length, "rotation announced itself").toBeGreaterThan(0);
    expect(rotate.join("\n")).toMatch(/\d+ row/);
  });

  it("the live log still reads correctly after rotation", () => {
    const log = new RecipeRunLog({ dir });
    fillPastCap(log, 400);
    // The most recent run must still be queryable — rotation keeps the tail.
    const rows = log.query({ recipe: "r", limit: 500 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.taskId).toBe("yaml:r:399");
  });
});
