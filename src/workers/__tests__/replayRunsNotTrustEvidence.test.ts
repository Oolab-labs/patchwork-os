/**
 * A replay run is not evidence.
 *
 * Mocked replay (src/recipes/replayRun.ts) re-runs a recipe with every step
 * short-circuited to its CAPTURED output and appends the result to
 * `runs.jsonl` like any other run. Nothing dispatched — but the row still
 * carries `status: "ok"` steps and the original's captured outputs (issue
 * URLs included). If trust replay folded it, re-running yesterday's evidence
 * N times would manufacture N-fold trust, and an outcome confirmed for the
 * ORIGINAL filing would be credited again to every replay of it.
 *
 * Each test has a positive control — the identical row WITHOUT a replay
 * marker does move the dial — so the assertion cannot pass merely because the
 * fixture was inert.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReplayRun } from "../../runLog.js";
import { OutcomeStore } from "../outcomeStore.js";
import { loadWorkerTrustForRecipe } from "../runWorkerShadow.js";

const RECIPE = "replay-evidence-example-recipe";
const WORKER = "replay-evidence-example-worker";
const ISSUE = "https://example.test/acct-0001/issues/1";
const DAY = 24 * 60 * 60 * 1000;

let home: string;
let saved: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-replay-evidence-"));
  mkdirSync(path.join(home, "workers"), { recursive: true });
  writeFileSync(
    path.join(home, "workers", "example.worker.yaml"),
    `id: ${WORKER}\nname: Example\nrecipe: ${RECIPE}\nowns:\n  - fs-write\n  - issue\nautonomyCeiling: 4\n`,
  );
  saved = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

type Marker = "field" | "legacy-chained" | "legacy-flat" | "none";

function row(i: number, marker: Marker, at: number): Record<string, unknown> {
  const taskId =
    marker === "legacy-chained"
      ? `replay:1:${RECIPE}:${at + i}`
      : `yaml:${RECIPE}:${at + i}`;
  return {
    seq: i + 1,
    taskId,
    recipeName: RECIPE,
    trigger: "recipe",
    status: "done",
    createdAt: at + i,
    startedAt: at + i,
    doneAt: at + i + 10,
    durationMs: 10,
    ...(marker === "field" && { replay: true }),
    ...(marker === "legacy-flat" && { manualRunId: "replay-1" }),
    stepResults: [
      {
        id: "w",
        tool: "file.write",
        status: "ok",
        durationMs: 1,
        resolvedParams: { path: "out.txt" },
      },
      {
        id: "i",
        tool: "github.create_issue",
        status: "ok",
        durationMs: 1,
        output: { url: ISSUE },
      },
    ],
  };
}

function writeRuns(marker: Marker, n: number, now: number): void {
  // Settled (older than the durability window) so the checkpoint path folds
  // them too, not only the live tail.
  const at = now - 3 * DAY;
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify(row(i, marker, at)),
  );
  writeFileSync(path.join(home, "runs.jsonl"), `${lines.join("\n")}\n`);
}

function confirmIssue(now: number): void {
  new OutcomeStore(home).upsert({
    issueUrl: ISSUE,
    disposition: "confirmed",
    checkedAt: now - 2 * DAY,
    recipeName: RECIPE,
    origin: "manual",
  });
}

function dial(now: number): string {
  const trust = loadWorkerTrustForRecipe(RECIPE, { now });
  expect(trust?.worker.id).toBe(WORKER);
  return trust?.store.toJSONL() ?? "";
}

describe("replay runs never fold as worker trust evidence", () => {
  it.each<Marker>([
    "field",
    "legacy-chained",
    "legacy-flat",
  ])("N replayed runs (%s marker) leave the dial exactly where no runs leave it", (marker) => {
    const now = Date.now();
    confirmIssue(now);
    const baseline = dial(now);
    writeRuns(marker, 12, now);
    expect(dial(now + 1)).toBe(baseline);
  });

  it("positive control: the same rows WITHOUT a marker do move the dial", () => {
    const now = Date.now();
    confirmIssue(now);
    const baseline = dial(now);
    writeRuns("none", 12, now);
    expect(dial(now + 1)).not.toBe(baseline);
  });

  it("isReplayRun recognises every marker and nothing else", () => {
    const now = Date.now();
    expect(isReplayRun(row(0, "field", now) as never)).toBe(true);
    expect(isReplayRun(row(0, "legacy-chained", now) as never)).toBe(true);
    expect(isReplayRun(row(0, "legacy-flat", now) as never)).toBe(true);
    expect(isReplayRun(row(0, "none", now) as never)).toBe(false);
    expect(
      isReplayRun({ taskId: "yaml:x:1", manualRunId: "attempt-7" } as never),
    ).toBe(false);
  });
});
