/**
 * patchwork traces export — bundle the four local trace logs into a
 * single round-trippable file so a user can move machines, take a
 * compliance snapshot, or share traces with another tool without the
 * fragile-glob ritual of finding each .jsonl by hand.
 *
 * Output format (Decision 1 / option A in the 2026-05-02 strategic walk-through):
 * a single gzipped JSONL file. Line 1 is a manifest envelope; every
 * subsequent line is a per-row envelope. Encryption is intentionally NOT
 * in this PR — encryption is a 2-hour follow-up once we know which
 * passphrase / KMS UX the user wants.
 *
 *   {"type":"manifest","version":1,"exportedAt":"...","sources":[...],"counts":{...}}
 *   {"source":"runs","entry":{...one runs.jsonl row...}}
 *   {"source":"decision_traces","entry":{...one decision_traces.jsonl row...}}
 *   ...
 *
 * Round-trip with `gunzip -c file.jsonl.gz | jq`. Filter one source with
 * `gunzip -c file.jsonl.gz | jq 'select(.source=="decision_traces") | .entry'`.
 *
 * Memory/Ecosystem strategic-plan agent (2026-05-02) flagged trace
 * durability as the top backlog item — see
 * `docs/strategic/2026-05-02/memory-ecosystem-report.md` items 1, 3, 12.
 * Without this, every claim about "years of personal AI memory" is
 * undercut by the existing 1 MB / 10 000-line silent rotation.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const TRACES_EXPORT_VERSION = 1;

/**
 * Logical sources we bundle. Adding a new source: extend this enum, add
 * a discoverer below, and consumer tooling that filters on source.
 */
export type TraceSource =
  | "runs"
  | "decision_traces"
  | "commit_issue_links"
  | "activity";

export interface TracesExportOptions {
  /** Where to write the bundle. Default: `${patchworkDir}/traces-export-{ISO}.jsonl.gz` (or `.jsonl.gz.age` if encrypted). */
  output?: string;
  /** Directory containing runs.jsonl / decision_traces.jsonl / commit_issue_links.jsonl. Default: `~/.patchwork/`. */
  patchworkDir?: string;
  /** Directory containing `activity-{port}.jsonl` files. Default: `~/.claude/ide/`. */
  activityDir?: string;
  /**
   * Encrypt the bundle with a passphrase using the age format
   * (https://age-encryption.org/v1). When set:
   *   - Pipeline becomes data → gzip → age-encrypt → file
   *   - Default output extension changes to `.jsonl.gz.age`
   *   - Decrypt with the standard `age` CLI:
   *       age -d -o traces.jsonl.gz traces-export-...jsonl.gz.age
   *     followed by `gunzip -c traces.jsonl.gz | jq`
   *   - Or with `age-encryption` JS lib in the same one-liner shape as encrypt
   *
   * Buffering vs streaming: age's encrypt() takes a Uint8Array, not a
   * stream, so we buffer the gzipped bundle before encrypting. For
   * personal traces this is fine — the upstream logs rotate at
   * ~1 MB / 10 000 lines so the buffered worst-case is single-digit MB.
   * If a future bundle source pushes this beyond memory comfort, swap
   * to age's streaming wrapper (when one ships) or chunk into multiple
   * encrypted files keyed by source.
   */
  encrypt?: { passphrase: string };
}

export interface TracesExportSourceFile {
  /** Logical source. */
  source: TraceSource;
  /** Absolute path read. */
  path: string;
  /** Number of JSONL rows successfully parsed and emitted. */
  count: number;
  /** Bytes read from disk. */
  bytes: number;
}

export interface TracesExportResult {
  /** Absolute path of the written `.jsonl.gz` bundle. */
  outputPath: string;
  /** ISO-8601 timestamp recorded in the manifest. */
  exportedAt: string;
  /** Per-source-file accounting. Multiple files possible for `activity` (one per bridge instance). */
  files: TracesExportSourceFile[];
  /** Total rows across all files. */
  totalCount: number;
  /** Total bytes read across all files. */
  totalBytes: number;
}

interface ManifestEnvelope {
  type: "manifest";
  version: typeof TRACES_EXPORT_VERSION;
  exportedAt: string;
  /** Logical sources present in this bundle (deduped). */
  sources: TraceSource[];
  /** Per-file accounting. */
  files: Array<{
    source: TraceSource;
    /** Path *relative to* the discovery dir, so the manifest doesn't leak the user's full home path. */
    relativePath: string;
    count: number;
    bytes: number;
  }>;
  /** Total rows across all files. */
  totalCount: number;
}

interface RowEnvelope {
  source: TraceSource;
  /** The original JSONL row, parsed. Unparseable rows are dropped (they would break the bundle's JSONL invariant). */
  entry: unknown;
  /**
   * For `activity` source only: the bridge instance file the row came
   * from (e.g. `activity-3000.jsonl`). Lets a downstream consumer
   * reconstruct multi-instance history. Omitted for single-file sources.
   */
  file?: string;
}

function defaultPatchworkDir(): string {
  return path.join(os.homedir(), ".patchwork");
}

function defaultActivityDir(): string {
  return path.join(os.homedir(), ".claude", "ide");
}

/** Single-file sources live at fixed names in the patchwork dir. */
const SINGLE_FILE_SOURCES: ReadonlyArray<{
  source: Exclude<TraceSource, "activity">;
  filename: string;
}> = [
  { source: "runs", filename: "runs.jsonl" },
  { source: "decision_traces", filename: "decision_traces.jsonl" },
  { source: "commit_issue_links", filename: "commit_issue_links.jsonl" },
];

/**
 * Discover activity-log files. Bridge instances each persist to
 * `activity-{port}.jsonl` so we glob for that pattern and include any
 * file that exists. Single explicit `activity.jsonl` (no port suffix)
 * is also picked up — some test harnesses use that name.
 */
function discoverActivityFiles(activityDir: string): string[] {
  if (!existsSync(activityDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(activityDir);
  } catch {
    return [];
  }
  return entries
    .filter(
      (name) =>
        /^activity(-\d+)?\.jsonl$/i.test(name) ||
        /^activity-log\.jsonl$/i.test(name),
    )
    .map((name) => path.join(activityDir, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

async function readJsonlRows(
  filePath: string,
): Promise<{ rows: unknown[]; bytes: number }> {
  const rows: unknown[] = [];
  let bytes = 0;
  try {
    bytes = statSync(filePath).size;
  } catch {
    return { rows, bytes: 0 };
  }
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Drop unparseable rows. The export's invariant is "every line is
      // valid JSON"; preserving a malformed line would break consumers.
    }
  }
  return { rows, bytes };
}

/**
 * Run the export. Pure function over filesystem state — no log instance
 * handles needed, so it works headless (e.g. in CI restoring a snapshot)
 * and during a running bridge alike (the export reads files atomically
 * line-by-line; concurrent appends only add new rows beyond the export's
 * point-in-time view).
 */
export async function runTracesExport(
  opts: TracesExportOptions = {},
): Promise<TracesExportResult> {
  const exportedAt = new Date().toISOString();
  const patchworkDir = opts.patchworkDir ?? defaultPatchworkDir();
  const activityDir = opts.activityDir ?? defaultActivityDir();

  // Default output: `<patchworkDir>/traces-export-<safeIso>.jsonl.gz`
  // (or `.jsonl.gz.age` when --encrypt is set). ISO colons are
  // filename-hostile on Windows so swap them for hyphens.
  const safeStamp = exportedAt.replace(/:/g, "-").replace(/\..+$/, "");
  const ext = opts.encrypt ? "jsonl.gz.age" : "jsonl.gz";
  const outputPath =
    opts.output ?? path.join(patchworkDir, `traces-export-${safeStamp}.${ext}`);

  // Discover sources.
  const files: Array<{
    source: TraceSource;
    path: string;
    relativePath: string;
    rows: unknown[];
    bytes: number;
    activityFile?: string;
  }> = [];

  for (const { source, filename } of SINGLE_FILE_SOURCES) {
    const p = path.join(patchworkDir, filename);
    if (!existsSync(p)) continue;
    const { rows, bytes } = await readJsonlRows(p);
    files.push({ source, path: p, relativePath: filename, rows, bytes });
  }
  for (const p of discoverActivityFiles(activityDir)) {
    const { rows, bytes } = await readJsonlRows(p);
    files.push({
      source: "activity",
      path: p,
      relativePath: path.basename(p),
      rows,
      bytes,
      activityFile: path.basename(p),
    });
  }

  // Ensure output dir exists.
  const outputDir = path.dirname(outputPath);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  // Build manifest from discovered files (even ones with zero rows are
  // recorded — "we looked here and found this" is more useful than silence).
  const totalCount = files.reduce((sum, f) => sum + f.rows.length, 0);
  const sources = [
    ...new Set(files.map((f) => f.source)),
  ].sort() as TraceSource[];
  const manifest: ManifestEnvelope = {
    type: "manifest",
    version: TRACES_EXPORT_VERSION,
    exportedAt,
    sources,
    files: files.map((f) => ({
      source: f.source,
      relativePath: f.relativePath,
      count: f.rows.length,
      bytes: f.bytes,
    })),
    totalCount,
  };

  // Build the JSONL stream first. When encrypting, we collect into a
  // buffer because age's encrypt() takes a Uint8Array, not a stream
  // (see TracesExportOptions.encrypt comment for the buffering tradeoff).
  // When not encrypting, we pipe gzip directly to disk.
  if (opts.encrypt) {
    const collected: Buffer[] = [];
    const gzip = createGzip();
    const collectPromise = (async () => {
      for await (const chunk of gzip) {
        collected.push(chunk as Buffer);
      }
    })();
    gzip.write(`${JSON.stringify(manifest)}\n`);
    for (const f of files) {
      for (const entry of f.rows) {
        const env: RowEnvelope = { source: f.source, entry };
        if (f.activityFile) env.file = f.activityFile;
        gzip.write(`${JSON.stringify(env)}\n`);
      }
    }
    gzip.end();
    await collectPromise;
    const gzippedBytes = Buffer.concat(collected);

    // Lazy-import age-encryption so users who never use --encrypt don't
    // pay the load cost. The dep is small but module init does scrypt
    // parameter discovery on first call.
    const { Encrypter } = await import("age-encryption");
    const encrypter = new Encrypter();
    encrypter.setPassphrase(opts.encrypt.passphrase);
    const ciphertext = await encrypter.encrypt(
      new Uint8Array(
        gzippedBytes.buffer,
        gzippedBytes.byteOffset,
        gzippedBytes.byteLength,
      ),
    );
    // Write directly — fs.writeFileSync respects mode on creation.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputPath, Buffer.from(ciphertext), { mode: 0o600 });
  } else {
    // Plain pipeline: data → gzip → file.
    const gzip = createGzip();
    const sink = createWriteStream(outputPath, { mode: 0o600 });
    const writeChunk = (line: string): boolean => gzip.write(`${line}\n`);
    const drainPromise = pipeline(gzip, sink);

    writeChunk(JSON.stringify(manifest));
    for (const f of files) {
      for (const entry of f.rows) {
        const env: RowEnvelope = { source: f.source, entry };
        if (f.activityFile) env.file = f.activityFile;
        writeChunk(JSON.stringify(env));
      }
    }
    gzip.end();
    await drainPromise;
  }

  return {
    outputPath,
    exportedAt,
    files: files.map((f) => ({
      source: f.source,
      path: f.path,
      count: f.rows.length,
      bytes: f.bytes,
    })),
    totalCount,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}
