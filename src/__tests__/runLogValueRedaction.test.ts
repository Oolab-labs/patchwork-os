/**
 * Registered secret values never reach runs.jsonl, the run-store mirror, or
 * a reader of the run log (audit M3, 2026-10-15).
 *
 * Step outputs were already scrubbed when captured. The run row's own text
 * fields were not: `errorMessage`, `outputTail`, a step's `error` and
 * `haltReason` — exactly where an upstream error that echoes a token lands.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetSecretValuesForTesting,
  registerSecretValue,
} from "../governance/secretValues.js";
import { RecipeRunLog } from "../runLog.js";

const SECRET = "sk-live-0123456789abcdefSECRET";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runlog-redaction-"));
  registerSecretValue(SECRET, "test");
});
afterEach(() => {
  _resetSecretValuesForTesting();
  rmSync(dir, { recursive: true, force: true });
});

function runWithSecretEverywhere(log: RecipeRunLog): number {
  const seq = log.startRun({
    taskId: "task-redaction",
    recipeName: "redaction-probe",
    trigger: "manual",
    createdAt: Date.now(),
  });
  log.completeRun(seq, {
    status: "error",
    doneAt: Date.now(),
    durationMs: 5,
    errorMessage: `upstream said: invalid key ${SECRET}`,
    outputTail: `last output ${SECRET}`,
    stepResults: [
      {
        id: "send",
        tool: "http.post",
        status: "error",
        error: `401 for token ${SECRET}`,
        haltReason: `http_rejected: ${SECRET} was refused`,
        durationMs: 1,
      } as never,
    ],
  });
  return seq;
}

describe("run log value redaction", () => {
  it("never writes a registered secret to runs.jsonl", () => {
    const log = new RecipeRunLog({ dir });
    runWithSecretEverywhere(log);
    const disk = readFileSync(join(dir, "runs.jsonl"), "utf8");
    expect(disk).not.toContain(SECRET);
    expect(disk).toContain("[REDACTED:test]");
  });

  it("never returns a registered secret to a reader", () => {
    const log = new RecipeRunLog({ dir });
    const seq = runWithSecretEverywhere(log);
    for (const view of [
      log.query(),
      log.getBySeq(seq),
      log.getByTaskId("task-redaction"),
      log.getAllBySeq(seq),
    ]) {
      expect(JSON.stringify(view)).not.toContain(SECRET);
    }
  });

  it("keeps the rest of the row intact", () => {
    const log = new RecipeRunLog({ dir });
    const seq = runWithSecretEverywhere(log);
    const run = log.getBySeq(seq);
    expect(run?.status).toBe("error");
    expect(run?.errorMessage).toMatch(/^upstream said: invalid key /);
    expect(run?.stepResults?.[0]?.status).toBe("error");
  });
});

describe("activity log lifecycle metadata redaction", () => {
  it("never hands a registered secret to a listener or stores it", async () => {
    const { ActivityLog } = await import("../activityLog.js");
    const log = new ActivityLog();
    const seen: unknown[] = [];
    log.subscribe((_kind: string, entry: unknown) => seen.push(entry));
    log.recordEvent("orchestrator_task_failed", {
      sessionId: "s1",
      error: `provider rejected ${SECRET}`,
    });
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    // Lookups by id still work: ids are not secrets.
    expect(JSON.stringify(seen)).toContain('"sessionId":"s1"');
  });
});
