import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceRetention } from "../evidenceRetention.js";
import {
  computePendingConfirmations,
  getWorkerShadowData,
} from "../runWorkerShadow.js";

/**
 * A non-reversible success must survive a 24h durability window before it
 * counts as evidence. But `runs.jsonl` is capped by BYTES, not time, and one
 * high-frequency recipe can consume the whole budget — on the machine this was
 * found, retention was 18.2 hours against a 24 hour window, so a worker's
 * filing was deleted BEFORE it could ever settle. Trust for compensable and
 * irreversible actions was therefore unearnable in principle, not merely slow.
 *
 * Rotation now archives to `runs.jsonl.1` (#1334); trust replay has to actually
 * READ it, or the evidence is preserved somewhere nothing looks.
 */
describe("trust evidence survives rotation", () => {
  let dir: string;
  let workersDir: string;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "retention-"));
    workersDir = path.join(dir, "workers");
    mkdirSync(workersDir, { recursive: true });
    writeFileSync(
      path.join(workersDir, "e.worker.yaml"),
      [
        "id: errands-worker",
        "name: Errands",
        "recipe: errand",
        "owns:",
        "  - tasks",
      ].join("\n"),
      "utf-8",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runRow = (taskId: string, at: number, id: string) =>
    JSON.stringify({
      seq: 1,
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
          output: { id },
        },
      ],
    });

  it("a filing rotated into the archive is still seen by the confirm queue", () => {
    // The live file holds an unrelated recent run; the worker's filing has
    // already been rotated out into the archive.
    writeFileSync(
      path.join(dir, "runs.jsonl"),
      `${runRow("yaml:other:9", Date.now(), "OTHER")}\n`.replace(
        '"recipeName":"errand"',
        '"recipeName":"noise"',
      ),
      "utf-8",
    );
    writeFileSync(
      path.join(dir, "runs.jsonl.1"),
      `${runRow("yaml:errand:1", Date.now() - 2 * DAY, "ARCHIVED1")}\n`,
      "utf-8",
    );

    const pending = computePendingConfirmations({
      workersDir,
      patchworkDir: dir,
    });
    expect(pending.map((p) => p.actionKey)).toEqual([
      "todoist.create_task:ARCHIVED1",
    ]);
  });

  it("does not double-count a run present in BOTH files", () => {
    // Rotation copies rows out; a crash between the archive write and the trim
    // can legitimately leave the same taskId in each. It must resolve to ONE
    // run, not two observations.
    //
    // Asserted on the DIAL, not the confirm queue: the queue dedups by
    // actionKey on its own, so a double-count there is invisible and the test
    // would pass whether or not readRuns deduped at all.
    const row = (taskId: string) =>
      JSON.stringify({
        seq: 1,
        taskId,
        recipeName: "errand",
        trigger: "recipe",
        status: "done",
        createdAt: Date.now() - 2 * DAY,
        doneAt: Date.now() - 2 * DAY,
        durationMs: 1,
        stepResults: [
          {
            id: "read",
            tool: "todoist.list_tasks", // reversible -> folds as evidence
            status: "ok",
            durationMs: 1,
          },
        ],
      });
    writeFileSync(
      path.join(dir, "runs.jsonl"),
      `${row("yaml:errand:dup")}\n`,
      "utf-8",
    );
    writeFileSync(
      path.join(dir, "runs.jsonl.1"),
      `${row("yaml:errand:dup")}\n`,
      "utf-8",
    );

    const data = getWorkerShadowData({ workersDir, patchworkDir: dir });
    const board =
      data.workers.find((w) => w.workerId === "errands-worker")?.board ?? [];
    const row0 = board.find((b) => b.classKey.startsWith("tasks-read"));
    expect(row0?.observations, "one run, one observation").toBe(1);
  });

  it("works when no archive exists at all", () => {
    writeFileSync(
      path.join(dir, "runs.jsonl"),
      `${runRow("yaml:errand:2", Date.now() - 2 * DAY, "LIVE1")}\n`,
      "utf-8",
    );
    expect(
      computePendingConfirmations({ workersDir, patchworkDir: dir }),
    ).toHaveLength(1);
  });
});

describe("evidenceRetention makes the cliff visible", () => {
  let dir: string;
  const HOUR = 60 * 60 * 1000;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "retspan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const row = (at: number) =>
    JSON.stringify({
      seq: 1,
      taskId: `t${at}`,
      recipeName: "r",
      trigger: "recipe",
      status: "done",
      createdAt: at,
      doneAt: at,
      durationMs: 1,
    });

  it("reports INSUFFICIENT when retention is under the durability window", () => {
    const now = 1_000 * HOUR;
    writeFileSync(
      path.join(dir, "runs.jsonl"),
      [row(now - 18 * HOUR), row(now)].join("\n"),
      "utf-8",
    );
    const r = evidenceRetention(dir, { now, windowMs: 24 * HOUR });
    expect(r.spanMs).toBe(18 * HOUR);
    expect(r.sufficient).toBe(false);
    expect(r.summary).toMatch(/18h.*24h/);
  });

  it("counts the archive toward retention", () => {
    const now = 1_000 * HOUR;
    writeFileSync(path.join(dir, "runs.jsonl"), row(now), "utf-8");
    writeFileSync(
      path.join(dir, "runs.jsonl.1"),
      row(now - 100 * HOUR),
      "utf-8",
    );
    const r = evidenceRetention(dir, { now, windowMs: 24 * HOUR });
    expect(r.spanMs).toBe(100 * HOUR);
    expect(r.sufficient).toBe(true);
  });

  it("an empty log is not reported as a retention failure", () => {
    // No runs yet is a new install, not a starved ledger. Reporting it as a
    // cliff would cry wolf on every fresh machine.
    const r = evidenceRetention(dir, { now: 1000, windowMs: 24 * HOUR });
    expect(r.rows).toBe(0);
    expect(r.sufficient).toBe(true);
  });
});
