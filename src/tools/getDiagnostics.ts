import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import { biomeLinter } from "./linters/biome.js";
import { cargoLinter } from "./linters/cargo.js";
import { eslintLinter } from "./linters/eslint.js";
import { govetLinter } from "./linters/govet.js";
import { pyrightLinter } from "./linters/pyright.js";
import { ruffLinter } from "./linters/ruff.js";
import type { LintDiagnostic, LinterRunner } from "./linters/types.js";
import { typescriptLinter } from "./linters/typescript.js";
import { optionalString, success, toFileUri } from "./utils.js";

// Cap diagnostic message length and strip control characters to prevent
// prompt injection from malicious LSP servers or linters.
const MAX_MESSAGE_LEN = 500;
function sanitizeMessage(msg: unknown): string {
  const s = typeof msg === "string" ? msg : String(msg ?? "");
  return s.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, MAX_MESSAGE_LEN);
}

const ALL_LINTERS: LinterRunner[] = [
  typescriptLinter,
  eslintLinter,
  pyrightLinter,
  ruffLinter,
  cargoLinter,
  govetLinter,
  biomeLinter,
];

interface LinterCache {
  data: LintDiagnostic[];
  timestamp: number;
}

export function createGetDiagnosticsTool(
  workspace: string,
  probes?: ProbeResults,
  extensionClient?: ExtensionClient,
  linterFilter?: string[],
) {
  // Per-linter independent caches
  const caches = new Map<string, LinterCache>();
  const runningPromises = new Map<string, Promise<LintDiagnostic[]>>();

  // Detect available linters at registration time
  const availableLinters = probes
    ? ALL_LINTERS.filter((l) => {
        if (linterFilter && linterFilter.length > 0) {
          return linterFilter.includes(l.name) && l.detect(workspace, probes);
        }
        return l.detect(workspace, probes);
      })
    : [];

  const linterErrors = new Map<string, string>();

  async function runLinter(
    linter: LinterRunner,
    signal?: AbortSignal,
  ): Promise<LintDiagnostic[]> {
    const now = Date.now();
    const cached = caches.get(linter.name);
    if (cached && now - cached.timestamp < linter.cacheTtl) {
      return cached.data;
    }

    // Dedup concurrent runs — but don't serve a dedup'd result if our signal is fine
    // and the existing promise was from an aborted request
    let running = runningPromises.get(linter.name);
    if (running && signal?.aborted) {
      return running; // We're aborted anyway, dedup is fine
    }
    if (!running) {
      running = linter
        .run(workspace, signal)
        .then((data) => {
          caches.set(linter.name, { data, timestamp: Date.now() });
          return data;
        })
        .catch((err: unknown) => {
          // Don't cache aborted results — they're incomplete
          if (!(err instanceof Error) || err.name !== "AbortError") {
            caches.set(linter.name, { data: [], timestamp: Date.now() });
            linterErrors.set(
              linter.name,
              err instanceof Error ? err.message : String(err),
            );
          }
          return [] as LintDiagnostic[];
        })
        .finally(() => {
          runningPromises.delete(linter.name);
        });
      runningPromises.set(linter.name, running);
    }
    return running;
  }

  return {
    schema: {
      name: "getDiagnostics",
      description:
        "Get diagnostics (errors, warnings) from available linters. Supports TypeScript, ESLint, Pyright, Ruff, Cargo, Go vet, and Biome. When the VS Code extension is connected, returns real-time LSP diagnostics instead.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          uri: {
            type: "string",
            description:
              "Optional file filter — accepts an absolute path, workspace-relative path, or file:// URI. When provided, returns diagnostics for that file only.",
          },
          severity: {
            type: "string",
            enum: ["error", "warning", "information", "hint"],
            description:
              "Only return diagnostics at or above this severity level. Ordered from highest to lowest: 'error', 'warning', 'information', 'hint'. Use 'error' to focus on build-breaking issues only.",
          },
          maxResults: {
            type: "number",
            description:
              "Limit the number of diagnostics returned. Default: 500. Use a lower value for large projects.",
          },
        },
      },
    },

    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const uri = optionalString(args, "uri");
      const severityFilter = optionalString(args, "severity") as
        | "error"
        | "warning"
        | "hint"
        | "information"
        | undefined;
      const maxResults =
        typeof args.maxResults === "number"
          ? Math.min(Math.max(1, Math.floor(args.maxResults)), 2000)
          : 500;

      const SEVERITY_RANK: Record<string, number> = {
        error: 3,
        warning: 2,
        information: 1,
        hint: 0,
      };
      const minRank =
        severityFilter !== undefined
          ? (SEVERITY_RANK[severityFilter] ?? 0)
          : -1;

      function applyFilters(diags: unknown[]): unknown[] {
        let filtered = diags;
        if (minRank >= 0) {
          filtered = filtered.filter((d) => {
            const sev = (d as Record<string, unknown>).severity as
              | string
              | undefined;
            return (SEVERITY_RANK[sev ?? "hint"] ?? 0) >= minRank;
          });
        }
        const truncated = filtered.length > maxResults;
        return truncated ? filtered.slice(0, maxResults) : filtered;
      }

      // Try extension first — real-time aggregated LSP diagnostics
      if (extensionClient?.isConnected()) {
        try {
          const extDiags = await extensionClient.getDiagnostics(uri);
          if (extDiags !== null) {
            let extDiagsArr: unknown[];
            let extTruncated = false;
            const raw = extDiags as unknown;
            if (
              raw !== null &&
              typeof raw === "object" &&
              !Array.isArray(raw) &&
              "diagnostics" in (raw as object)
            ) {
              const env = raw as {
                diagnostics: unknown[];
                truncated?: boolean;
              };
              extDiagsArr = env.diagnostics;
              extTruncated = env.truncated ?? false;
            } else {
              extDiagsArr = raw as unknown[];
            }
            const sanitized = extDiagsArr.map((d) => {
              if (
                d !== null &&
                typeof d === "object" &&
                "message" in (d as object)
              ) {
                return {
                  ...(d as object),
                  message: sanitizeMessage(
                    (d as Record<string, unknown>).message,
                  ),
                };
              }
              return d;
            });
            const filtered = applyFilters(sanitized);
            return success({
              available: true,
              source: "extension",
              linters: ["vscode-lsp"],
              diagnostics: filtered,
              ...(severityFilter ? { severityFilter } : {}),
              ...(extTruncated || filtered.length < extDiagsArr.length
                ? { truncated: true, totalBeforeFilter: extDiagsArr.length }
                : {}),
              ...(extTruncated
                ? {
                    note: "Capped at 500 total diagnostics — use uri filter to get complete diagnostics for a specific file",
                  }
                : {}),
            });
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to CLI linter fallback
        }
      }

      // Fallback to CLI linters — run all in parallel
      if (availableLinters.length === 0) {
        return success({
          available: false,
          source: "cli",
          linters: [],
          diagnostics: [],
          error: "No linters detected in workspace",
        });
      }

      const results = await Promise.all(
        availableLinters.map((l) => runLinter(l, signal)),
      );
      let diagnostics = results.flat();

      // Filter by URI if specified
      if (uri) {
        const normalizedUri = uri.startsWith("file://") ? uri : toFileUri(uri);
        diagnostics = diagnostics.filter((d) => {
          const diagUri = d.file.startsWith("file://")
            ? d.file
            : toFileUri(d.file);
          return diagUri === normalizedUri;
        });
      }

      // Sanitize message fields before filtering/returning
      diagnostics = diagnostics.map((d) => ({
        ...d,
        message: sanitizeMessage(d.message),
      }));

      const totalBeforeFilter = diagnostics.length;
      const filteredDiags = applyFilters(
        diagnostics as unknown[],
      ) as typeof diagnostics;

      const summary = {
        total: filteredDiags.length,
        errors: filteredDiags.filter((d) => d.severity === "error").length,
        warnings: filteredDiags.filter((d) => d.severity === "warning").length,
      };

      const errors: Record<string, string> = {};
      for (const l of availableLinters) {
        const err = linterErrors.get(l.name);
        if (err) errors[l.name] = err;
      }

      return success({
        available: true,
        source: "cli",
        linters: availableLinters.map((l) => l.name),
        summary,
        diagnostics: filteredDiags,
        ...(severityFilter ? { severityFilter } : {}),
        ...(filteredDiags.length < totalBeforeFilter
          ? { truncated: true, totalBeforeFilter }
          : {}),
        ...(Object.keys(errors).length > 0 && { linterErrors: errors }),
      });
    },
  };
}
