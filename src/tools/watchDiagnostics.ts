import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import type { ToolHandler } from "../transport.js";
import { biomeLinter } from "./linters/biome.js";

const execFileAsync = promisify(execFile);

const BLAME_CACHE_TTL_MS = 30_000;
const BLAME_TIMEOUT_MS = 2_000;
/** Maximum concurrent git-blame subprocesses per enrichDiagnostics call. */
const BLAME_CONCURRENCY = 8;
/** Maximum blame cache entries per tool instance before FIFO eviction. */
const BLAME_CACHE_MAX_SIZE = 1_000;

interface BlameEntry {
  commitHash: string;
  cachedAt: number;
}

interface DiagnosticHistory {
  firstSeenAt: number;
  recurrenceCount: number;
}

import { cargoLinter } from "./linters/cargo.js";
import { eslintLinter } from "./linters/eslint.js";
import { govetLinter } from "./linters/govet.js";
import { pyrightLinter } from "./linters/pyright.js";
import { ruffLinter } from "./linters/ruff.js";
import type { LintDiagnostic, LinterRunner } from "./linters/types.js";
import { typescriptLinter } from "./linters/typescript.js";
import {
  optionalInt,
  optionalString,
  resolveFilePath,
  successStructured,
  toFileUri,
} from "./utils.js";

const ALL_LINTERS: LinterRunner[] = [
  typescriptLinter,
  eslintLinter,
  pyrightLinter,
  ruffLinter,
  cargoLinter,
  govetLinter,
  biomeLinter,
];

export function createWatchDiagnosticsTool(
  workspace: string,
  extensionClient: ExtensionClient,
  probes?: ProbeResults,
  linterFilter?: string[],
) {
  // Per-instance blame cache — scoped to this tool instance to prevent
  // cross-test pollution and allow independent TTL/size management.
  const blameCache = new Map<string, BlameEntry>();

  function evictBlameCache(): void {
    if (blameCache.size <= BLAME_CACHE_MAX_SIZE) return;
    // FIFO eviction: delete the oldest inserted key
    const firstKey = blameCache.keys().next().value;
    if (firstKey !== undefined) blameCache.delete(firstKey);
  }

  async function getIntroducedByCommit(
    file: string,
    line: number,
  ): Promise<string | undefined> {
    const key = `${file}:${line}`;
    const cached = blameCache.get(key);
    if (cached && Date.now() - cached.cachedAt < BLAME_CACHE_TTL_MS) {
      return cached.commitHash;
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["blame", "-L", `${line},${line}`, "--porcelain", "--", file],
        { cwd: workspace, timeout: BLAME_TIMEOUT_MS },
      );
      const hash = stdout.slice(0, 40).trim();
      if (/^[0-9a-f]{40}$/.test(hash) && !hash.startsWith("0000000")) {
        blameCache.set(key, { commitHash: hash, cachedAt: Date.now() });
        evictBlameCache();
        return hash;
      }
    } catch {
      // git not available, file not tracked, or timeout — silently omit
    }
    return undefined;
  }

  // Per-instance diagnostic history: "file:line:message_prefix" → { firstSeenAt, recurrenceCount }
  // Capped to prevent unbounded growth in long-running sessions.
  const DIAG_HISTORY_MAX_SIZE = 5_000;
  const diagHistory = new Map<string, DiagnosticHistory>();

  async function enrichOneDiagnostic(
    d: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const file = typeof d.file === "string" ? d.file : "";
    const line =
      typeof d.line === "number"
        ? d.line
        : typeof d.range === "object" && d.range !== null
          ? ((
              (d.range as Record<string, unknown>).start as Record<
                string,
                number
              >
            )?.line ?? 0)
          : 0;
    // Truncate message to 120 chars to keep map keys bounded
    const msgRaw = typeof d.message === "string" ? d.message : "";
    const message = msgRaw.slice(0, 120);
    const key = `${file}:${line}:${message}`;
    const now = Date.now();
    const existing = diagHistory.get(key);
    if (existing) {
      existing.recurrenceCount += 1;
    } else {
      // Evict oldest entry before inserting when at cap
      if (diagHistory.size >= DIAG_HISTORY_MAX_SIZE) {
        const oldest = diagHistory.keys().next().value;
        if (oldest !== undefined) diagHistory.delete(oldest);
      }
      diagHistory.set(key, { firstSeenAt: now, recurrenceCount: 1 });
    }
    const entry = diagHistory.get(key) ?? {
      firstSeenAt: now,
      recurrenceCount: 1,
    };
    const enriched: Record<string, unknown> = {
      ...d,
      firstSeenAt: entry.firstSeenAt,
      recurrenceCount: entry.recurrenceCount,
    };
    if (file && line > 0) {
      const commit = await getIntroducedByCommit(file, line);
      if (commit) enriched.introducedByCommit = commit;
    }
    return enriched;
  }

  async function enrichDiagnostics(
    diagnostics: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    // Process in batches to cap concurrent git-blame subprocesses
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < diagnostics.length; i += BLAME_CONCURRENCY) {
      const batch = diagnostics.slice(i, i + BLAME_CONCURRENCY);
      const enriched = await Promise.all(batch.map(enrichOneDiagnostic));
      results.push(...enriched);
    }
    return results;
  }

  /** Shared error handler for floating enrichment promises. */
  function onEnrichError(_err: unknown): void {
    // enrichDiagnostics is best-effort; swallow errors silently
  }

  // Detect available linters at registration time (same logic as getDiagnostics)
  const availableLinters = probes
    ? ALL_LINTERS.filter((l) => {
        if (linterFilter && linterFilter.length > 0) {
          return linterFilter.includes(l.name) && l.detect(workspace, probes);
        }
        return l.detect(workspace, probes);
      })
    : [];

  return {
    schema: {
      name: "watchDiagnostics",
      description:
        "Long-poll for diagnostic changes. Use after edits to wait for LSP re-validation.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          filePath: {
            type: "string" as const,
            description:
              "Optional: only watch diagnostics for this specific file",
          },
          timeoutMs: {
            type: "integer" as const,
            description:
              "Max wait time in milliseconds (default: 10000, max: 30000)",
          },
          sinceTimestamp: {
            type: "integer" as const,
            description:
              "Only return if diagnostics changed after this timestamp (from a previous watchDiagnostics call)",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          changed: { type: "boolean" },
          timestamp: { type: "integer" },
          diagnostics: { type: "array" },
          count: { type: "integer" },
          source: { type: "string" },
          linters: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
        required: ["changed", "timestamp", "diagnostics", "count"],
        description:
          "Diagnostic entries from extension path include firstSeenAt, recurrenceCount, and optional introducedByCommit fields.",
      },
    },
    timeoutMs: 120_000,
    handler: (async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = optionalString(args, "filePath");
      const resolvedPath = rawPath
        ? resolveFilePath(rawPath, workspace)
        : undefined;
      const timeoutMs = Math.min(
        optionalInt(args, "timeoutMs", 1000, 30_000) ?? 10_000,
        30_000,
      );
      const sinceTimestamp = optionalInt(
        args,
        "sinceTimestamp",
        0,
        Number.MAX_SAFE_INTEGER,
      );

      // --- Extension path: real-time long-poll ---
      if (extensionClient.isConnected()) {
        // Check if already changed since requested timestamp.
        // Use explicit undefined check — sinceTimestamp=0 is valid and must not be skipped.
        if (
          sinceTimestamp !== undefined &&
          extensionClient.lastDiagnosticsUpdate > sinceTimestamp
        ) {
          const rawDiagnostics =
            extensionClient.getCachedDiagnostics(resolvedPath);
          const diagnostics = await enrichDiagnostics(
            rawDiagnostics as unknown as Array<Record<string, unknown>>,
          );
          return successStructured({
            changed: true,
            timestamp: extensionClient.lastDiagnosticsUpdate,
            diagnostics,
            count: diagnostics.length,
          });
        }

        // Long-poll: wait for change or timeout
        return new Promise<ReturnType<typeof successStructured>>((resolve) => {
          // Fast-path: if the signal is already aborted before we enter the
          // executor, settle immediately without allocating the timer or
          // registering the diagnostics listener.
          if (signal?.aborted) {
            const rawDiagnostics =
              extensionClient.getCachedDiagnostics(resolvedPath);
            enrichDiagnostics(
              rawDiagnostics as unknown as Array<Record<string, unknown>>,
            )
              .then((diagnostics) => {
                resolve(
                  successStructured({
                    changed: false,
                    timestamp: extensionClient.lastDiagnosticsUpdate,
                    diagnostics,
                    count: diagnostics.length,
                  }),
                );
              })
              .catch(onEnrichError);
            return;
          }

          let settled = false;
          // All cleanup-state variables are fully assigned BEFORE any listener
          // registration or TOCTOU re-check so that cleanup() is safe to call
          // from settle() at any point after this block.
          let timer: ReturnType<typeof setTimeout> | undefined;
          let abortHandler: (() => void) | undefined;
          let unsubscribe: (() => void) | undefined;

          const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            if (abortHandler !== undefined)
              signal?.removeEventListener("abort", abortHandler);
            unsubscribe?.();
          };

          const settle = (changed: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            const rawDiagnostics =
              extensionClient.getCachedDiagnostics(resolvedPath);
            enrichDiagnostics(
              rawDiagnostics as unknown as Array<Record<string, unknown>>,
            )
              .then((diagnostics) => {
                resolve(
                  successStructured({
                    changed,
                    timestamp: extensionClient.lastDiagnosticsUpdate,
                    diagnostics,
                    count: diagnostics.length,
                  }),
                );
              })
              .catch(onEnrichError);
          };

          // Step 1: set up the timeout timer FIRST so cleanup() is never called
          // with an uninitialized timer reference.
          timer = setTimeout(() => settle(false), timeoutMs);

          // Step 2: set up the abort handler and register it BEFORE subscribing
          // so cleanup() can always remove it.
          abortHandler = () => settle(false);
          signal?.addEventListener("abort", abortHandler);

          // Step 3: register the diagnostics listener.
          unsubscribe = extensionClient.addDiagnosticsListener((file) => {
            if (!resolvedPath || file === resolvedPath) {
              settle(true);
            }
          });

          // Step 4 (TOCTOU re-check): MUST happen AFTER subscription — a
          // diagnosticsChanged notification could have fired between the initial
          // timestamp check (above) and addDiagnosticsListener (just above).
          // If so, settle immediately rather than waiting for timeout.
          if (
            sinceTimestamp !== undefined &&
            extensionClient.lastDiagnosticsUpdate > sinceTimestamp
          ) {
            settle(true);
            return;
          }
        });
      }

      // --- Native fallback: run CLI linters immediately ---
      // Cannot replicate real-time watching without the extension; return a point-in-time snapshot.
      const now = Date.now();

      if (availableLinters.length === 0) {
        return successStructured({
          changed: false,
          timestamp: now,
          diagnostics: [],
          count: 0,
          source: "cli",
          note: "No linters detected — install tsc, eslint, or biome to get CLI diagnostics",
        });
      }

      const results = await Promise.all(
        availableLinters.map((l) =>
          l.run(workspace, signal).catch((): LintDiagnostic[] => []),
        ),
      );
      let diagnostics = results.flat();

      // Filter by file path if specified
      if (resolvedPath) {
        const normalizedUri = toFileUri(resolvedPath);
        diagnostics = diagnostics.filter((d) => {
          const diagUri = d.file.startsWith("file://")
            ? d.file
            : toFileUri(d.file);
          return diagUri === normalizedUri;
        });
      }

      return successStructured({
        changed: true,
        timestamp: now,
        diagnostics,
        count: diagnostics.length,
        source: "cli",
        linters: availableLinters.map((l) => l.name),
      });
    }) as ToolHandler,
  };
}
