import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkerShadowData } from "../runWorkerShadow.js";

const WORKERS_DIR = path.join(process.cwd(), "templates", "workers");

describe("getWorkerShadowData", () => {
  let emptyDir: string;
  beforeEach(() => {
    emptyDir = mkdtempSync(path.join(os.tmpdir(), "pw-shadow-data-"));
  });
  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns a structured per-worker report (empty logs → empty dials)", () => {
    const data = getWorkerShadowData({
      workersDir: WORKERS_DIR,
      patchworkDir: emptyDir, // no runs.jsonl
      ideDir: emptyDir, // no activity-*.jsonl
    });
    expect(data.workers.length).toBeGreaterThanOrEqual(3);
    expect(data.workers[0]).toHaveProperty("workerId");
    expect(data.workers[0]).toHaveProperty("board");
    expect(data.workers[0]).toHaveProperty("autonomyCeiling");
    expect(data.runsScanned).toBe(0);
    expect(data.decisionsScanned).toBe(0);
  });

  it("returns no workers when the workers dir is absent", () => {
    const data = getWorkerShadowData({
      workersDir: path.join(emptyDir, "nope"),
      patchworkDir: emptyDir,
      ideDir: emptyDir,
    });
    expect(data.workers).toEqual([]);
  });
});
