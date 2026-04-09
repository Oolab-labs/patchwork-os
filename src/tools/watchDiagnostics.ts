import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import type { ToolHandler } from "../transport.js";
import { biomeLinter } from "./linters/biome.js";
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
  success,
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
        "Wait for diagnostic changes. Long-polls until change or timeout. " +
        "Use after edits to wait for the language server to re-validate.",
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
          const diagnostics =
            extensionClient.getCachedDiagnostics(resolvedPath);
          return success({
            changed: true,
            timestamp: extensionClient.lastDiagnosticsUpdate,
            diagnostics,
            count: diagnostics.length,
          });
        }

        // Long-poll: wait for change or timeout
        return new Promise<ReturnType<typeof success>>((resolve) => {
          // Fast-path: if the signal is already aborted before we enter the
          // executor, settle immediately without allocating the timer or
          // registering the diagnostics listener.
          if (signal?.aborted) {
            const diagnostics =
              extensionClient.getCachedDiagnostics(resolvedPath);
            resolve(
              success({
                changed: false,
                timestamp: extensionClient.lastDiagnosticsUpdate,
                diagnostics,
                count: diagnostics.length,
              }),
            );
            return;
          }

          let settled = false;
          // Declare mutable refs before cleanup/settle so cleanup is always
          // initialized before settle can call it — avoids TDZ ReferenceError
          // when the inner re-check triggers settle() before timer/abortHandler
          // are assigned. `let` is required: each var is assigned after its
          // declaration (in a later statement), not at declaration time.
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
            const diagnostics =
              extensionClient.getCachedDiagnostics(resolvedPath);
            resolve(
              success({
                changed,
                timestamp: extensionClient.lastDiagnosticsUpdate,
                diagnostics,
                count: diagnostics.length,
              }),
            );
          };

          unsubscribe = extensionClient.addDiagnosticsListener((file) => {
            if (!resolvedPath || file === resolvedPath) {
              settle(true);
            }
          });

          // Re-check after registering the listener to close the TOCTOU window:
          // a `diagnosticsChanged` notification could have fired between the
          // initial timestamp check (above) and `addDiagnosticsListener` (just
          // above). If so, settle immediately rather than waiting for timeout.
          if (
            sinceTimestamp !== undefined &&
            extensionClient.lastDiagnosticsUpdate > sinceTimestamp
          ) {
            settle(true);
            return;
          }

          timer = setTimeout(() => settle(false), timeoutMs);

          abortHandler = () => settle(false);
          signal?.addEventListener("abort", abortHandler);
        });
      }

      // --- Native fallback: run CLI linters immediately ---
      // Cannot replicate real-time watching without the extension; return a point-in-time snapshot.
      const now = Date.now();

      if (availableLinters.length === 0) {
        return success({
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

      return success({
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
