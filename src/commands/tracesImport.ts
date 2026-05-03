/**
 * patchwork traces import — restore a bundle written by `tracesExport` into
 * the local patchwork dirs. Closes the export → backup → restore-on-new-
 * machine loop that was half-shipped (export landed, import did not).
 *
 * Bundle format is the manifest+row-envelope schema from tracesExport.ts:
 *
 *   {"type":"manifest","version":1,"exportedAt":"...","sources":[...],"files":[...]}
 *   {"source":"runs","entry":{...}}
 *   {"source":"decision_traces","entry":{...}}
 *   ...
 *
 * Modes:
 *   - "append" (default) — entries are appended to the target file. The
 *     bundle's row order is preserved. No dedup; if you import the same
 *     bundle twice, you get duplicates. This is by design — dedup needs
 *     a stable key choice per source and we'd rather ship the simple
 *     thing now and add it as a follow-up.
 *   - "overwrite" — target file is truncated before any writes. Use
 *     this for "clean restore on a fresh machine" — never use it when
 *     there's local data you want to keep.
 *
 * Encryption: `.age` bundles must be decrypted out-of-band first
 * (`age -d bundle.jsonl.gz.age | gunzip > bundle.jsonl`). A `--decrypt`
 * flag is a small follow-up.
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { TRACES_EXPORT_VERSION, type TraceSource } from "./tracesExport.js";

export type ImportMode = "append" | "overwrite";

export interface TracesImportOptions {
  /** Path to a `.jsonl.gz` (or plain `.jsonl`) bundle written by tracesExport. */
  input: string;
  /** Where to restore single-file sources. Default: `~/.patchwork/`. */
  patchworkDir?: string;
  /** Where to restore activity-*.jsonl. Default: `~/.claude/ide/`. */
  activityDir?: string;
  /** "append" (default) or "overwrite". */
  mode?: ImportMode;
  /** Don't write anything — return what would happen. */
  dryRun?: boolean;
}

export interface TracesImportResult {
  inputPath: string;
  exportedAt: string;
  mode: ImportMode;
  dryRun: boolean;
  /** Per target-file accounting. Multiple files possible for activity (one per source bridge instance). */
  files: Array<{
    source: TraceSource;
    targetPath: string;
    /** Rows written (or that would be written, in dry-run). */
    count: number;
  }>;
  /** Total rows across all target files. */
  totalCount: number;
}

interface ManifestEnvelope {
  type: "manifest";
  version: number;
  exportedAt: string;
  sources: TraceSource[];
  files: Array<{
    source: TraceSource;
    relativePath: string;
    count: number;
    bytes: number;
  }>;
  totalCount: number;
}

const SINGLE_FILE_TARGETS: Record<Exclude<TraceSource, "activity">, string> = {
  runs: "runs.jsonl",
  decision_traces: "decision_traces.jsonl",
  commit_issue_links: "commit_issue_links.jsonl",
};

function defaultPatchworkDir(): string {
  return path.join(os.homedir(), ".patchwork");
}

function defaultActivityDir(): string {
  return path.join(os.homedir(), ".claude", "ide");
}

function resolveTargetPath(
  source: TraceSource,
  envelopeFile: string | undefined,
  patchworkDir: string,
  activityDir: string,
): string {
  if (source === "activity") {
    // activity rows carry the original file name — preserve it so a
    // multi-instance export round-trips per-port. Default fallback if
    // the envelope didn't include one.
    const name = envelopeFile ?? "activity.jsonl";
    return path.join(activityDir, name);
  }
  return path.join(patchworkDir, SINGLE_FILE_TARGETS[source]);
}

export async function runTracesImport(
  opts: TracesImportOptions,
): Promise<TracesImportResult> {
  const inputPath = path.resolve(opts.input);
  if (!existsSync(inputPath)) {
    throw new Error(`Input bundle not found: ${inputPath}`);
  }
  const mode: ImportMode = opts.mode ?? "append";
  const dryRun = opts.dryRun === true;
  const patchworkDir = opts.patchworkDir ?? defaultPatchworkDir();
  const activityDir = opts.activityDir ?? defaultActivityDir();

  if (!dryRun) {
    if (!existsSync(patchworkDir)) mkdirSync(patchworkDir, { recursive: true });
    if (!existsSync(activityDir)) mkdirSync(activityDir, { recursive: true });
  }

  // Stream-read the bundle. Auto-detect gzip via `.gz` suffix; users who
  // already gunzipped manually can pass the plain .jsonl.
  const baseStream = createReadStream(inputPath);
  const lineStream = inputPath.endsWith(".gz")
    ? baseStream.pipe(createGunzip())
    : baseStream;
  const rl = createInterface({ input: lineStream, crlfDelay: Infinity });

  let manifest: ManifestEnvelope | null = null;
  // Group writes by target so we can truncate-once for overwrite mode and
  // batch the appends. Memory cost is one row's worth of buffer per target,
  // which is acceptable for a CLI command operating on user-machine-sized
  // data.
  const buffers = new Map<string, { source: TraceSource; lines: string[] }>();
  let lineNum = 0;

  for await (const raw of rl) {
    lineNum++;
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Bundle parse error at line ${lineNum}: not valid JSON`);
    }

    if (lineNum === 1) {
      // First non-empty line must be the manifest.
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { type?: unknown }).type !== "manifest"
      ) {
        throw new Error(
          `First line of bundle is not a manifest envelope (got: ${line.slice(0, 80)}…)`,
        );
      }
      manifest = parsed as ManifestEnvelope;
      if (manifest.version !== TRACES_EXPORT_VERSION) {
        throw new Error(
          `Bundle version ${manifest.version} not supported (expected ${TRACES_EXPORT_VERSION})`,
        );
      }
      continue;
    }

    if (manifest === null) {
      throw new Error("Bundle has rows before a manifest line");
    }

    const env = parsed as {
      source?: unknown;
      entry?: unknown;
      file?: unknown;
    };
    if (typeof env.source !== "string" || env.entry === undefined) {
      throw new Error(`Bundle row at line ${lineNum} missing source/entry`);
    }
    const source = env.source as TraceSource;
    const file = typeof env.file === "string" ? env.file : undefined;
    const targetPath = resolveTargetPath(
      source,
      file,
      patchworkDir,
      activityDir,
    );
    const buf = buffers.get(targetPath) ?? { source, lines: [] };
    // Re-serialize the entry as one JSONL line. Tools downstream of these
    // files expect one JSON object per line, no envelope.
    buf.lines.push(JSON.stringify(env.entry));
    buffers.set(targetPath, buf);
  }

  if (manifest === null) {
    throw new Error("Bundle is empty (no manifest line)");
  }

  // Apply: in overwrite mode, truncate each target before appending its
  // batch. In append mode, just append.
  const files: TracesImportResult["files"] = [];
  let totalCount = 0;
  for (const [targetPath, buf] of buffers) {
    const count = buf.lines.length;
    totalCount += count;
    if (!dryRun) {
      // Ensure the target directory exists (activity-port files might
      // land in a dir we don't control — covered by the mkdir above for
      // the configured activityDir, but parent dir of arbitrary path
      // needs its own check).
      const parent = path.dirname(targetPath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      const payload = `${buf.lines.join("\n")}\n`;
      if (mode === "overwrite") {
        writeFileSync(targetPath, payload, "utf-8");
      } else {
        appendFileSync(targetPath, payload, "utf-8");
      }
    }
    files.push({ source: buf.source, targetPath, count });
  }

  return {
    inputPath,
    exportedAt: manifest.exportedAt,
    mode,
    dryRun,
    files: files.sort((a, b) => a.targetPath.localeCompare(b.targetPath)),
    totalCount,
  };
}
