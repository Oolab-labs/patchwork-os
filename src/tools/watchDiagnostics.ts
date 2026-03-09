import type { ExtensionClient } from "../extensionClient.js";
import { optionalString, optionalInt, resolveFilePath, success, error, extensionRequired } from "./utils.js";
import type { ToolHandler } from "../transport.js";

export function createWatchDiagnosticsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "watchDiagnostics",
      description:
        "Wait for diagnostic changes and return updated diagnostics. " +
        "Long-polls until diagnostics change or timeout. " +
        "Use this after making edits to wait for the language server to report new errors/warnings. " +
        "Returns immediately if diagnostics have already changed since the given timestamp.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description: "Optional: only watch diagnostics for this specific file",
          },
          timeoutMs: {
            type: "integer" as const,
            description: "Max wait time in milliseconds (default: 10000, max: 30000)",
          },
          sinceTimestamp: {
            type: "integer" as const,
            description: "Only return if diagnostics changed after this timestamp (from a previous watchDiagnostics call)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 120_000,
    handler: (async (args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!extensionClient.isConnected()) {
        return extensionRequired("watchDiagnostics");
      }

      const rawPath = optionalString(args, "filePath");
      const resolvedPath = rawPath ? resolveFilePath(rawPath, workspace) : undefined;
      const timeoutMs = Math.min(optionalInt(args, "timeoutMs", 1000, 30_000) ?? 10_000, 30_000);
      const sinceTimestamp = optionalInt(args, "sinceTimestamp", 0, Number.MAX_SAFE_INTEGER);

      // Check if already changed since requested timestamp.
      // Use explicit undefined check — sinceTimestamp=0 is valid and must not be skipped.
      if (sinceTimestamp !== undefined && extensionClient.lastDiagnosticsUpdate > sinceTimestamp) {
        const diagnostics = extensionClient.getCachedDiagnostics(resolvedPath);
        return success({
          changed: true,
          timestamp: extensionClient.lastDiagnosticsUpdate,
          diagnostics,
          count: diagnostics.length,
        });
      }

      // Long-poll: wait for change or timeout
      return new Promise<ReturnType<typeof success>>((resolve) => {
        let settled = false;

        const settle = (changed: boolean) => {
          if (settled) return;
          settled = true;
          cleanup();
          const diagnostics = extensionClient.getCachedDiagnostics(resolvedPath);
          resolve(success({
            changed,
            timestamp: extensionClient.lastDiagnosticsUpdate,
            diagnostics,
            count: diagnostics.length,
          }));
        };

        const unsubscribe = extensionClient.addDiagnosticsListener((file) => {
          if (!resolvedPath || file === resolvedPath) {
            settle(true);
          }
        });

        const timer = setTimeout(() => settle(false), timeoutMs);

        const abortHandler = () => settle(false);
        signal?.addEventListener("abort", abortHandler);

        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortHandler);
          unsubscribe();
        };
      });
    }) as ToolHandler,
  };
}
