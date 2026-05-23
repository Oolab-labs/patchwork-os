/**
 * shadowRun — replay historical run data through a candidate classifier
 * and report which runs would have been reclassified.
 *
 * Purely functional: no top-level I/O. All data access is via injected
 * `loadPastRuns` so tests mock without `vi.mock()` hoisting.
 *
 * NOTE on size limits: in real (non-test) usage, the injected `loadPastRuns`
 * should respect the same rotation thresholds used by RecipeRunLog in
 * src/runLog.ts: MAX_PERSIST_BYTES = 1 MB, MAX_PERSIST_LINES = 10 000.
 * Reading beyond those limits risks OOM on large run logs. The harness
 * itself applies no additional cap — that responsibility belongs to the
 * loader.
 */

export interface RunRecord {
  id: string;
  recipeName: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  timestamp: string;
}

export interface ClassificationResult {
  runId: string;
  recipeName: string;
  toolName: string;
  previousTier: "safe" | "review" | "block";
  newTier: "safe" | "review" | "block";
  reclassified: boolean;
  reason?: string;
}

export interface ShadowScanOptions {
  /** DI — not imported at top level. Real impl should respect MAX_PERSIST_BYTES / MAX_PERSIST_LINES from src/runLog.ts. */
  loadPastRuns: () => Promise<RunRecord[]>;
  classifier: (run: RunRecord) => ClassificationResult;
  /** Filter to runs with timestamp >= since.toISOString(). */
  since?: Date;
  /** Max runs to process after filtering. */
  limit?: number;
}

export interface ShadowScanResult {
  scanned: number;
  reclassified: number;
  classifications: ClassificationResult[];
  summary: string;
}

/** Error result returned when loadPastRuns throws — no propagation. */
function errorResult(err: unknown): ShadowScanResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    scanned: 0,
    reclassified: 0,
    classifications: [],
    summary: `Shadow scan failed: ${msg}`,
  };
}

export async function runShadowScan(
  opts: ShadowScanOptions,
): Promise<ShadowScanResult> {
  let runs: RunRecord[];
  try {
    runs = await opts.loadPastRuns();
  } catch (err) {
    return errorResult(err);
  }

  // Filter by since
  if (opts.since !== undefined) {
    const sinceIso = opts.since.toISOString();
    runs = runs.filter((r) => r.timestamp >= sinceIso);
  }

  // Apply limit
  if (opts.limit !== undefined) {
    runs = runs.slice(0, opts.limit);
  }

  const classifications = runs.map((r) => opts.classifier(r));
  const reclassifiedCount = classifications.filter(
    (c) => c.reclassified,
  ).length;

  const summary =
    runs.length === 0
      ? "No runs to scan."
      : `Scanned ${runs.length} run${runs.length === 1 ? "" : "s"}; ${reclassifiedCount} would be reclassified.`;

  return {
    scanned: runs.length,
    reclassified: reclassifiedCount,
    classifications,
    summary,
  };
}

/**
 * Example classifier: flags known destructive tool names as 'review'.
 * Exported for use in tests and as a reference implementation.
 */
export function destructiveToolClassifier(
  run: RunRecord,
): ClassificationResult {
  const destructiveTools = ["deleteFile", "runInTerminal", "searchAndReplace"];
  const tier = destructiveTools.includes(run.toolName) ? "review" : "safe";
  return {
    runId: run.id,
    recipeName: run.recipeName,
    toolName: run.toolName,
    previousTier: "safe",
    newTier: tier,
    reclassified: tier !== "safe",
    reason:
      tier === "review" ? `${run.toolName} is a destructive tool` : undefined,
  };
}
