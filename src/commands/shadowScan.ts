/**
 * `patchwork shadow-scan` CLI — replay historical run data through
 * the destructive-tool classifier and report which runs would be reclassified.
 *
 * Default runs source: ~/.claude/ide/runs.jsonl (outside any workspace —
 * do NOT validate through resolveFilePath). If --runs-file is supplied, it
 * IS workspace-scoped and validated through resolveFilePath.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  destructiveToolClassifier,
  type RunRecord,
  runShadowScan,
  type ShadowScanResult,
} from "../testing/shadowRun.js";
import { resolveFilePath } from "../tools/utils.js";

/** Max bytes the runs JSONL is allowed to be before we skip the read. */
const MAX_RUNS_BYTES = 1_048_576; // 1 MB

export interface ShadowScanCliOptions {
  /** ISO date string or relative like "24h", "7d". Default: last 7 days. */
  since?: string;
  limit?: number;
  /** Override default ~/.claude/ide/runs.jsonl path. Workspace-scoped. */
  runsFile?: string;
  /** Output JSON instead of human-readable text. */
  json?: boolean;
  /** Workspace root for resolveFilePath (required if runsFile is set). */
  workspace?: string;
}

/**
 * Parse a relative duration string like "24h" or "7d" into a Date that many
 * milliseconds in the past. If the string is not a recognised relative form,
 * fall back to `new Date(str)` (ISO 8601 parse).
 *
 * Exported so tests can call it directly.
 */
export function parseSinceDuration(str: string): Date {
  const relMatch = /^(\d+)(h|d)$/.exec(str.trim());
  if (relMatch) {
    const amount = parseInt(relMatch[1] as string, 10);
    const unit = relMatch[2] as "h" | "d";
    const ms = unit === "h" ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid since value: "${str}". Use ISO 8601 or relative like "24h", "7d".`,
    );
  }
  return parsed;
}

/**
 * Parse JSONL content into RunRecord[]. Malformed lines are skipped with a
 * stderr warning. Exported so tests can call it directly.
 */
export function parseRunsFile(content: string): RunRecord[] {
  const records: RunRecord[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        records.push(parsed as RunRecord);
      } else {
        process.stderr.write(
          `[shadow-scan] warn: line ${i + 1} is not an object — skipped\n`,
        );
      }
    } catch {
      process.stderr.write(
        `[shadow-scan] warn: line ${i + 1} is malformed JSON — skipped\n`,
      );
    }
  }
  return records;
}

function defaultRunsPath(): string {
  return path.join(os.homedir(), ".claude", "ide", "runs.jsonl");
}

function buildLoadPastRuns(runsPath: string): () => Promise<RunRecord[]> {
  return async () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(runsPath);
    } catch (err) {
      // File absent → no runs to scan
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    if (stat.size > MAX_RUNS_BYTES) {
      process.stderr.write(
        `[shadow-scan] warn: ${runsPath} is ${stat.size} bytes (> 1 MB limit) — skipping read\n`,
      );
      return [];
    }

    const content = fs.readFileSync(runsPath, "utf8");
    return parseRunsFile(content);
  };
}

function printHumanReadable(result: ShadowScanResult): void {
  process.stdout.write(`Scanned: ${result.scanned}\n`);
  process.stdout.write(`Reclassified: ${result.reclassified}\n`);
  if (result.reclassified === 0) {
    process.stdout.write("No runs would be reclassified.\n");
    return;
  }
  process.stdout.write("\n");
  for (const c of result.classifications) {
    if (!c.reclassified) continue;
    const reason = c.reason ?? "no reason given";
    process.stdout.write(
      `[REVIEW] ${c.recipeName} / ${c.toolName} — ${reason}\n`,
    );
  }
}

export async function runShadowScanCli(
  options: ShadowScanCliOptions = {},
): Promise<void> {
  // Parse --since
  let since: Date | undefined;
  if (options.since !== undefined) {
    since = parseSinceDuration(options.since);
  } else {
    // Default: last 7 days
    since = parseSinceDuration("7d");
  }

  // Resolve runs file path
  let runsPath: string;
  if (options.runsFile !== undefined) {
    // Explicitly provided — validate via resolveFilePath (workspace-scoped)
    const workspace = options.workspace ?? process.cwd();
    runsPath = resolveFilePath(options.runsFile, workspace);
  } else {
    // Default path is outside any workspace — do NOT use resolveFilePath
    runsPath = defaultRunsPath();
  }

  const loadPastRuns = buildLoadPastRuns(runsPath);

  const result = await runShadowScan({
    loadPastRuns,
    classifier: destructiveToolClassifier,
    since,
    limit: options.limit,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHumanReadable(result);
  }

  if (result.reclassified > 0) {
    process.exitCode = 1;
  }
}
