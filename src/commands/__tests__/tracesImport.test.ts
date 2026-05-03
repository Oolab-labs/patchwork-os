import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTracesExport } from "../tracesExport.js";
import { runTracesImport } from "../tracesImport.js";

describe("tracesImport", () => {
  let workDir: string;
  let srcPatchwork: string;
  let srcActivity: string;
  let dstPatchwork: string;
  let dstActivity: string;
  let bundlePath: string;

  beforeEach(() => {
    workDir = path.join(
      os.tmpdir(),
      `traces-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    srcPatchwork = path.join(workDir, "src-pw");
    srcActivity = path.join(workDir, "src-act");
    dstPatchwork = path.join(workDir, "dst-pw");
    dstActivity = path.join(workDir, "dst-act");
    mkdirSync(srcPatchwork, { recursive: true });
    mkdirSync(srcActivity, { recursive: true });
    bundlePath = path.join(workDir, "bundle.jsonl.gz");
  });

  afterEach(() => {
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  async function exportFromSrc() {
    return runTracesExport({
      output: bundlePath,
      patchworkDir: srcPatchwork,
      activityDir: srcActivity,
    });
  }

  it("round-trips a multi-source export through import (append mode)", async () => {
    writeFileSync(
      path.join(srcPatchwork, "runs.jsonl"),
      `${JSON.stringify({ seq: 1, recipe: "morning-brief" })}\n${JSON.stringify({ seq: 2, recipe: "capture-thought" })}\n`,
    );
    writeFileSync(
      path.join(srcPatchwork, "decision_traces.jsonl"),
      `${JSON.stringify({ id: "t1", problem: "X", solution: "Y" })}\n`,
    );
    writeFileSync(
      path.join(srcActivity, "activity-3000.jsonl"),
      `${JSON.stringify({ kind: "tool", tool: "git.log_since" })}\n`,
    );

    await exportFromSrc();
    expect(existsSync(bundlePath)).toBe(true);

    const result = await runTracesImport({
      input: bundlePath,
      patchworkDir: dstPatchwork,
      activityDir: dstActivity,
    });

    expect(result.totalCount).toBe(4);
    expect(result.mode).toBe("append");
    const runsContent = readFileSync(
      path.join(dstPatchwork, "runs.jsonl"),
      "utf-8",
    );
    expect(runsContent).toContain('"seq":1');
    expect(runsContent).toContain('"seq":2');
    const decisionsContent = readFileSync(
      path.join(dstPatchwork, "decision_traces.jsonl"),
      "utf-8",
    );
    expect(decisionsContent).toContain('"problem":"X"');
    const activityContent = readFileSync(
      path.join(dstActivity, "activity-3000.jsonl"),
      "utf-8",
    );
    expect(activityContent).toContain("git.log_since");
  });

  it("append mode duplicates rows when re-importing the same bundle", async () => {
    writeFileSync(
      path.join(srcPatchwork, "runs.jsonl"),
      `${JSON.stringify({ seq: 1 })}\n`,
    );
    await exportFromSrc();

    await runTracesImport({
      input: bundlePath,
      patchworkDir: dstPatchwork,
      activityDir: dstActivity,
    });
    await runTracesImport({
      input: bundlePath,
      patchworkDir: dstPatchwork,
      activityDir: dstActivity,
    });

    const content = readFileSync(
      path.join(dstPatchwork, "runs.jsonl"),
      "utf-8",
    );
    // documented behavior — append mode does not dedup
    expect(content.match(/"seq":1/g)?.length).toBe(2);
  });

  it("overwrite mode truncates target before writing", async () => {
    writeFileSync(
      path.join(srcPatchwork, "runs.jsonl"),
      `${JSON.stringify({ seq: 99 })}\n`,
    );
    await exportFromSrc();

    // Pre-existing content in destination — should be wiped by overwrite.
    mkdirSync(dstPatchwork, { recursive: true });
    writeFileSync(
      path.join(dstPatchwork, "runs.jsonl"),
      `${JSON.stringify({ seq: 1, stale: true })}\n`,
    );

    await runTracesImport({
      input: bundlePath,
      patchworkDir: dstPatchwork,
      activityDir: dstActivity,
      mode: "overwrite",
    });

    const content = readFileSync(
      path.join(dstPatchwork, "runs.jsonl"),
      "utf-8",
    );
    expect(content).not.toContain("stale");
    expect(content).toContain('"seq":99');
  });

  it("dry-run reports rows without touching disk", async () => {
    writeFileSync(
      path.join(srcPatchwork, "runs.jsonl"),
      `${JSON.stringify({ seq: 1 })}\n${JSON.stringify({ seq: 2 })}\n`,
    );
    await exportFromSrc();

    const result = await runTracesImport({
      input: bundlePath,
      patchworkDir: dstPatchwork,
      activityDir: dstActivity,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.totalCount).toBe(2);
    expect(existsSync(path.join(dstPatchwork, "runs.jsonl"))).toBe(false);
  });

  it("rejects a bundle with no manifest line", async () => {
    writeFileSync(
      bundlePath.replace(/\.gz$/, ""),
      '{"source":"runs","entry":{"seq":1}}\n',
    );
    await expect(
      runTracesImport({
        input: bundlePath.replace(/\.gz$/, ""),
        patchworkDir: dstPatchwork,
        activityDir: dstActivity,
      }),
    ).rejects.toThrow(/manifest/i);
  });

  it("rejects an unsupported bundle version", async () => {
    const plainBundle = bundlePath.replace(/\.gz$/, "");
    writeFileSync(
      plainBundle,
      `${JSON.stringify({ type: "manifest", version: 999, exportedAt: "now", sources: [], files: [], totalCount: 0 })}\n`,
    );
    await expect(
      runTracesImport({
        input: plainBundle,
        patchworkDir: dstPatchwork,
        activityDir: dstActivity,
      }),
    ).rejects.toThrow(/version 999/);
  });

  it("missing input file errors clearly", async () => {
    await expect(
      runTracesImport({
        input: path.join(workDir, "does-not-exist.jsonl.gz"),
        patchworkDir: dstPatchwork,
        activityDir: dstActivity,
      }),
    ).rejects.toThrow(/not found/);
  });
});
