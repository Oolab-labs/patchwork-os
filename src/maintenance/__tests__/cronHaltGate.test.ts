import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessCronHalts,
  CRON_HALT_MIN_CLEAN_DAYS,
  CRON_HALT_MIN_ERROR_STREAK,
  type CronRunRow,
  noteCronHaltFlip,
  readCronRuns,
} from "../cronHaltGate.js";
import { diffReadings, SWEEP_RV, type SweepReading } from "../sweep.js";
import { collectSweep } from "../sweepCollect.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pw-cronhalt-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Hourly cron runs: `cleanDays` days of `done` followed by `errors` errors,
 * the last error one hour before NOW. Returns rows oldest first.
 */
function hourly(
  recipe: string,
  cleanDays: number,
  errors: number,
  over: Partial<CronRunRow> = {},
): CronRunRow[] {
  const total = cleanDays * 24 + errors;
  const rows: CronRunRow[] = [];
  for (let i = 0; i < total; i++) {
    const createdAt = NOW - (total - i) * HOUR;
    rows.push({
      taskId: `${recipe}-${i}`,
      recipeName: recipe,
      trigger: "cron",
      status: i < cleanDays * 24 ? "done" : "error",
      createdAt,
      doneAt: createdAt + 1000,
      ...over,
    });
  }
  return rows;
}

/** Write rows as `runs.jsonl` the way the bridge does (one row per event). */
function writeRunLog(dir: string, rows: CronRunRow[]): void {
  const lines = rows.map((r, i) =>
    JSON.stringify({ seq: i + 1, durationMs: 1000, ...r }),
  );
  writeFileSync(path.join(dir, "runs.jsonl"), `${lines.join("\n")}\n`);
}

describe("assessCronHalts", () => {
  it("flips on 8 clean days followed by 6 consecutive errors", () => {
    const a = assessCronHalts(hourly("noisy-recipe", 8, 6), { now: NOW });
    expect(a.eligible).toBe(1);
    expect(a.failing).toHaveLength(1);
    expect(a.failing[0]?.recipeName).toBe("noisy-recipe");
    expect(a.failing[0]?.errorStreak).toBe(6);
    // The first failing run, not the latest one: that is the moment to look at.
    expect(a.failing[0]?.firstFailureAt).toBe(NOW - 6 * HOUR);
  });

  it("does not flip on 5 consecutive errors", () => {
    const a = assessCronHalts(hourly("noisy-recipe", 8, 5), { now: NOW });
    expect(a.eligible).toBe(1);
    expect(a.failing).toEqual([]);
  });

  it("does not flip on 6 errors with only 3 days of history: a baseline is not a flip", () => {
    const a = assessCronHalts(hourly("noisy-recipe", 3, 6), { now: NOW });
    expect(a.eligible).toBe(0);
    expect(a.failing).toEqual([]);
  });

  it("ignores runs that were not started by the scheduler", () => {
    const rows = hourly("noisy-recipe", 8, 6, { trigger: "manual" });
    const a = assessCronHalts(rows, { now: NOW });
    expect(a.eligible).toBe(0);
    expect(a.failing).toEqual([]);
  });

  it("a done run after the errors ends the streak", () => {
    const rows = hourly("noisy-recipe", 8, 6);
    const last = rows[rows.length - 1] as CronRunRow;
    rows.push({
      ...last,
      taskId: "recovered",
      status: "done",
      createdAt: last.createdAt + HOUR,
      doneAt: last.createdAt + HOUR + 1000,
    });
    expect(assessCronHalts(rows, { now: NOW }).failing).toEqual([]);
  });

  it("pins the thresholds the rule was decided with", () => {
    expect(CRON_HALT_MIN_CLEAN_DAYS).toBe(7);
    expect(CRON_HALT_MIN_ERROR_STREAK).toBe(6);
  });
});

describe("readCronRuns", () => {
  it("reads the run log through the shared reader, deduped by taskId", () => {
    const dir = tmp();
    const rows = hourly("noisy-recipe", 8, 6);
    // The bridge writes a `running` row and then the terminal row for the
    // same taskId. Counting both would double the streak.
    const doubled = rows.flatMap((r) => [{ ...r, status: "running" }, r]);
    writeRunLog(dir, doubled as CronRunRow[]);
    const read = readCronRuns(dir);
    expect(read).toHaveLength(rows.length);
    expect(read.every((r) => r.status !== "running")).toBe(true);
    expect(assessCronHalts(read, { now: NOW }).failing).toHaveLength(1);
  });

  it("reports an unreadable log as absent rather than as zero runs", () => {
    const dir = tmp();
    expect(readCronRuns(dir)).toEqual([]);
  });
});

describe("the sweep gate", () => {
  it("carries the gate and counts only, never the recipe name", () => {
    const dir = tmp();
    writeRunLog(dir, hourly("sweep-fixture-unique-token", 8, 6));
    const r = collectSweep({ dir, now: NOW });
    expect(r.gates["cronHalts"]).toBe(false);
    expect(r.counts["cronHalts.eligibleRecipes"]).toBe(1);
    expect(r.counts["cronHalts.failing"]).toBe(1);
    expect(JSON.stringify(r)).not.toContain("sweep-fixture-unique-token");
  });

  it("omits the gate when there is no run log to read", () => {
    const r = collectSweep({ dir: tmp(), now: NOW });
    expect("cronHalts" in r.gates).toBe(false);
    expect("cronHalts.failing" in r.counts).toBe(false);
  });
});

describe("noteCronHaltFlip", () => {
  function reading(gate: boolean | undefined): SweepReading {
    return {
      rv: SWEEP_RV,
      takenAt: NOW,
      gates: gate === undefined ? {} : { cronHalts: gate },
      counts: {},
    };
  }

  it("writes one inbox note per flip, naming the recipe and the first failing run", () => {
    const dir = tmp();
    const inbox = path.join(dir, "inbox");
    const assessment = assessCronHalts(hourly("noisy-recipe", 8, 6), {
      now: NOW,
    });
    const delta = diffReadings(reading(true), reading(false));
    const written = noteCronHaltFlip({ delta, assessment, inbox, now: NOW });
    expect(written).toBeDefined();
    const files = readdirSync(inbox);
    expect(files).toHaveLength(1);
    const text = readFileSync(path.join(inbox, files[0] as string), "utf-8");
    // The run header the inbox reader expects, so it lists like any delivery.
    expect(text.startsWith("---\nrecipe: sweep\n")).toBe(true);
    expect(text).toContain("deliveredAt: ");
    expect(text).toContain("noisy-recipe");
    expect(text).toContain(new Date(NOW - 6 * HOUR).toISOString());

    // While it STAYS failing nothing flips, so nothing is written again.
    const steady = diffReadings(reading(false), reading(false));
    expect(
      noteCronHaltFlip({ delta: steady, assessment, inbox, now: NOW + HOUR }),
    ).toBeUndefined();
    expect(readdirSync(inbox)).toHaveLength(1);
  });

  it("writes nothing on a first sweep or when the previous snapshot lacked the gate", () => {
    const dir = tmp();
    const inbox = path.join(dir, "inbox");
    const assessment = assessCronHalts(hourly("noisy-recipe", 8, 6), {
      now: NOW,
    });
    expect(
      noteCronHaltFlip({
        delta: diffReadings(undefined, reading(false)),
        assessment,
        inbox,
        now: NOW,
      }),
    ).toBeUndefined();
    expect(
      noteCronHaltFlip({
        delta: diffReadings(reading(undefined), reading(false)),
        assessment,
        inbox,
        now: NOW,
      }),
    ).toBeUndefined();
    expect(existsSync(inbox)).toBe(false);
  });

  it("does not need the inbox directory to exist in advance", () => {
    const dir = tmp();
    const inbox = path.join(dir, "nested", "inbox");
    mkdirSync(path.dirname(inbox), { recursive: true });
    const assessment = assessCronHalts(hourly("noisy-recipe", 8, 6), {
      now: NOW,
    });
    noteCronHaltFlip({
      delta: diffReadings(reading(true), reading(false)),
      assessment,
      inbox,
      now: NOW,
    });
    expect(readdirSync(inbox)).toHaveLength(1);
  });
});
