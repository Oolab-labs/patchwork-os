import {
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTracesExport, TRACES_EXPORT_VERSION } from "../tracesExport.js";

interface ParsedBundle {
  manifest: {
    type: "manifest";
    version: number;
    exportedAt: string;
    sources: string[];
    files: Array<{
      source: string;
      relativePath: string;
      count: number;
      bytes: number;
    }>;
    totalCount: number;
  };
  rows: Array<{ source: string; entry: unknown; file?: string }>;
}

async function readBundle(file: string): Promise<ParsedBundle> {
  const lines: string[] = [];
  const gz = createReadStream(file).pipe(createGunzip());
  const rl = createInterface({ input: gz, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    lines.push(line);
  }
  if (lines.length === 0) {
    throw new Error("empty bundle");
  }
  const first = lines[0];
  if (first === undefined) throw new Error("empty bundle");
  const manifest = JSON.parse(first);
  const rows = lines.slice(1).map((l) => JSON.parse(l));
  return { manifest, rows };
}

describe("runTracesExport", () => {
  // Use a unique tmp dir per test run; clean up after.
  const tmpRoot = path.join(os.tmpdir(), `patchwork-traces-${Date.now()}`);
  const patchworkDir = path.join(tmpRoot, "patchwork");
  const activityDir = path.join(tmpRoot, "ide");

  beforeEach(() => {
    mkdirSync(patchworkDir, { recursive: true });
    mkdirSync(activityDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("exports a manifest line + one envelope per row across all four sources", async () => {
    writeFileSync(
      path.join(patchworkDir, "runs.jsonl"),
      `${JSON.stringify({ seq: 1, recipeName: "demo", status: "ok" })}\n${JSON.stringify({ seq: 2, recipeName: "demo", status: "error" })}\n`,
    );
    writeFileSync(
      path.join(patchworkDir, "decision_traces.jsonl"),
      `${JSON.stringify({ id: "t1", traceType: "approval", key: "Bash" })}\n`,
    );
    writeFileSync(
      path.join(patchworkDir, "commit_issue_links.jsonl"),
      `${JSON.stringify({ commit: "abc", issue: "#42" })}\n`,
    );
    writeFileSync(
      path.join(activityDir, "activity-3000.jsonl"),
      `${JSON.stringify({ id: 1, event: "tool" })}\n${JSON.stringify({ id: 2, event: "tool" })}\n${JSON.stringify({ id: 3, event: "approval_decision" })}\n`,
    );

    const result = await runTracesExport({
      patchworkDir,
      activityDir,
      output: path.join(tmpRoot, "out.jsonl.gz"),
    });

    expect(result.totalCount).toBe(7); // 2 + 1 + 1 + 3
    expect(result.files).toHaveLength(4);
    expect(existsSync(result.outputPath)).toBe(true);

    const bundle = await readBundle(result.outputPath);
    expect(bundle.manifest.type).toBe("manifest");
    expect(bundle.manifest.version).toBe(TRACES_EXPORT_VERSION);
    expect(bundle.manifest.totalCount).toBe(7);
    expect(bundle.manifest.sources.sort()).toEqual([
      "activity",
      "commit_issue_links",
      "decision_traces",
      "runs",
    ]);
    expect(bundle.rows).toHaveLength(7);

    // Each envelope has a recognizable source label and a parsed entry.
    const bySource: Record<string, unknown[]> = {};
    for (const r of bundle.rows) {
      (bySource[r.source] ??= []).push(r.entry);
    }
    expect(bySource.runs).toHaveLength(2);
    expect(bySource.decision_traces).toHaveLength(1);
    expect(bySource.commit_issue_links).toHaveLength(1);
    expect(bySource.activity).toHaveLength(3);

    // Activity envelopes carry the source filename so multi-instance
    // history can be reconstructed.
    const activityEnv = bundle.rows.filter((r) => r.source === "activity");
    for (const a of activityEnv) {
      expect(a.file).toBe("activity-3000.jsonl");
    }
  });

  it("round-trips entries unchanged (no field loss, no reordering inside a source)", async () => {
    const decisionRows = [
      { id: "d1", traceType: "approval", key: "Bash", decidedAt: 100 },
      { id: "d2", traceType: "approval", key: "Read", decidedAt: 200 },
      { id: "d3", traceType: "approval", key: "Write", decidedAt: 300 },
    ];
    writeFileSync(
      path.join(patchworkDir, "decision_traces.jsonl"),
      `${decisionRows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );

    const result = await runTracesExport({
      patchworkDir,
      activityDir,
      output: path.join(tmpRoot, "out.jsonl.gz"),
    });

    const bundle = await readBundle(result.outputPath);
    const exported = bundle.rows
      .filter((r) => r.source === "decision_traces")
      .map((r) => r.entry);
    expect(exported).toEqual(decisionRows);
  });

  it("merges multiple activity-{port}.jsonl files in deterministic order", async () => {
    writeFileSync(
      path.join(activityDir, "activity-3000.jsonl"),
      `${JSON.stringify({ id: 1, port: 3000 })}\n`,
    );
    writeFileSync(
      path.join(activityDir, "activity-3001.jsonl"),
      `${JSON.stringify({ id: 1, port: 3001 })}\n`,
    );
    // A non-activity file in the same dir must be ignored.
    writeFileSync(
      path.join(activityDir, "unrelated.jsonl"),
      `${JSON.stringify({ id: 99 })}\n`,
    );

    const result = await runTracesExport({
      patchworkDir,
      activityDir,
      output: path.join(tmpRoot, "out.jsonl.gz"),
    });

    expect(result.files.filter((f) => f.source === "activity")).toHaveLength(2);
    const bundle = await readBundle(result.outputPath);
    const activity = bundle.rows.filter((r) => r.source === "activity");
    expect(activity).toHaveLength(2);
    // Sorted by filename → 3000 before 3001.
    expect(activity[0]?.file).toBe("activity-3000.jsonl");
    expect(activity[1]?.file).toBe("activity-3001.jsonl");
    // Unrelated file's row not included.
    for (const a of activity) {
      expect((a.entry as Record<string, unknown>).id).not.toBe(99);
    }
  });

  it("succeeds when source directories are empty (manifest with zero files)", async () => {
    const result = await runTracesExport({
      patchworkDir,
      activityDir,
      output: path.join(tmpRoot, "out.jsonl.gz"),
    });
    expect(result.totalCount).toBe(0);
    expect(result.files).toHaveLength(0);

    const bundle = await readBundle(result.outputPath);
    expect(bundle.manifest.files).toEqual([]);
    expect(bundle.manifest.sources).toEqual([]);
    expect(bundle.rows).toHaveLength(0);
  });

  it("drops unparseable JSONL lines without aborting the whole export", async () => {
    writeFileSync(
      path.join(patchworkDir, "runs.jsonl"),
      `${JSON.stringify({ seq: 1, recipeName: "ok" })}\n` +
        "this is not valid json\n" +
        `${JSON.stringify({ seq: 2, recipeName: "ok" })}\n`,
    );

    const result = await runTracesExport({
      patchworkDir,
      activityDir,
      output: path.join(tmpRoot, "out.jsonl.gz"),
    });
    expect(result.totalCount).toBe(2);

    const bundle = await readBundle(result.outputPath);
    expect(bundle.rows).toHaveLength(2);
    for (const r of bundle.rows) {
      expect(typeof (r.entry as Record<string, unknown>).seq).toBe("number");
    }
  });

  it("writes the bundle with 0o600 perms (no group/world read)", async () => {
    writeFileSync(
      path.join(patchworkDir, "runs.jsonl"),
      `${JSON.stringify({ seq: 1 })}\n`,
    );
    const result = await runTracesExport({
      patchworkDir,
      activityDir,
      output: path.join(tmpRoot, "out.jsonl.gz"),
    });
    const mode = statSync(result.outputPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("default output filename is ISO-stamped under patchworkDir", async () => {
    writeFileSync(
      path.join(patchworkDir, "runs.jsonl"),
      `${JSON.stringify({ seq: 1 })}\n`,
    );
    const result = await runTracesExport({ patchworkDir, activityDir });
    expect(result.outputPath.startsWith(patchworkDir)).toBe(true);
    expect(
      /\/traces-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl\.gz$/.test(
        result.outputPath,
      ),
    ).toBe(true);
  });
});
