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
import { optionalString, successStructuredLarge, toFileUri } from "./utils.js";

// Cap diagnostic message length and strip control characters to prevent
// prompt injection from malicious LSP servers or linters.
const MAX_MESSAGE_LEN = 500;
const MAX_RELATED_INFORMATION = 5;
const MAX_RELATED_MSG_LEN = 200;
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
  // Tracks in-flight linter runs. Stores the origin signal alongside the promise
  // so we can detect when the original caller was aborted and start a fresh run
  // for a new non-aborted caller rather than deduping onto a doomed promise.
  const runningPromises = new Map<
    string,
    {
      promise: Promise<LintDiagnostic[]>;
      originSignal: AbortSignal | undefined;
    }
  >();

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

    // Dedup concurrent runs, with one exception: if the in-flight run was
    // started by a signal that has since been aborted, that run will resolve
    // to [] without caching. A new non-aborted caller must start a fresh run
    // rather than deduping onto the doomed promise.
    let entry = runningPromises.get(linter.name);
    if (entry?.originSignal?.aborted) {
      entry = undefined; // origin caller aborted — treat as no run in-flight
    }
    if (entry && signal?.aborted) {
      return entry.promise; // caller is aborted anyway — dedup is fine
    }
    if (!entry && signal?.aborted) {
      // No in-flight run and caller is already cancelled — return immediately
      // rather than starting a new linter process that will be immediately killed.
      return [];
    }
    if (!entry) {
      // Capture a stable reference to this run so the .finally() cleanup
      // only removes the entry it created (not a newer run that started
      // between the origin signal aborting and .finally() firing).
      const run: {
        promise: Promise<LintDiagnostic[]>;
        originSignal: AbortSignal | undefined;
      } = {
        promise: null as unknown as Promise<LintDiagnostic[]>,
        originSignal: signal,
      };
      run.promise = linter
        .run(workspace, signal)
        .then((data) => {
          caches.set(linter.name, { data, timestamp: Date.now() });
          linterErrors.delete(linter.name);
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
          // Only evict if this run is still the current entry — a newer run
          // may have already replaced it while this one was aborting.
          if (runningPromises.get(linter.name) === run) {
            runningPromises.delete(linter.name);
          }
        });
      runningPromises.set(linter.name, run);
      entry = run;
    }
    return entry.promise;
  }

  return {
    schema: {
      name: "getDiagnostics",
      description:
        "Errors/warnings from TS, ESLint, Pyright, Ruff, Cargo, Go vet, Biome. Real-time LSP when ext connected.",
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
              "Limit the number of diagnostics returned. Default: 100, max: 2000.",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          source: { type: "string" },
          linters: { type: "array", items: { type: "string" } },
          linterErrors: { type: "object" },
          diagnostics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                severity: {
                  type: "string",
                  enum: ["error", "warning", "information", "hint"],
                },
                message: { type: "string" },
                rule: { type: "string" },
                line: { type: "integer" },
                column: { type: "integer" },
                endLine: { type: "integer" },
                endColumn: { type: "integer" },
                source: { type: "string" },
              },
              required: ["file", "severity", "message"],
            },
          },
          summary: { type: "object" },
          truncated: { type: "boolean" },
        },
        required: ["available", "source", "diagnostics"],
      },
    },

    // 30s: CLI linters (tsc, biome) can be slow on cold start over VPS disk
    timeoutMs: 30_000,
    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
      progress?: import("../transport.js").ProgressFn,
    ) {
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
          : 100;

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
                const rec = d as Record<string, unknown>;
                const result: Record<string, unknown> = {
                  ...rec,
                  message: sanitizeMessage(rec.message),
                };
                if (Array.isArray(rec.relatedInformation)) {
                  result.relatedInformation = rec.relatedInformation
                    .slice(0, MAX_RELATED_INFORMATION)
                    .map((ri: unknown) => {
                      if (
                        ri !== null &&
                        typeof ri === "object" &&
                        "message" in (ri as object)
                      ) {
                        const r = ri as Record<string, unknown>;
                        return {
                          ...r,
                          message: sanitizeMessage(r.message).slice(
                            0,
                            MAX_RELATED_MSG_LEN,
                          ),
                        };
                      }
                      return ri;
                    });
                }
                return result;
              }
              return d;
            });
            const filtered = applyFilters(sanitized);
            return successStructuredLarge({
              available: true,
              source: "extension",
              linters: ["vscode-lsp"],
              linterErrors: {},
              diagnostics: filtered,
              ...(severityFilter ? { severityFilter } : {}),
              ...(extTruncated || filtered.length < extDiagsArr.length
                ? {
                    truncated: true,
                    totalBeforeFilter: extDiagsArr.length,
                    ...(extTruncated
                      ? {
                          truncatedReason:
                            "Capped by extension limit — pass uri to get complete diagnostics for a specific file",
                        }
                      : {}),
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
        return successStructuredLarge({
          available: false,
          source: "cli",
          linters: [],
          linterErrors: {},
          diagnostics: [],
          error: "No linters detected in workspace",
        });
      }

      const total = availableLinters.length;
      let completed = 0;
      progress?.(0, total, `Running ${total} linter${total !== 1 ? "s" : ""}…`);
      const results = await Promise.all(
        availableLinters.map((l) =>
          runLinter(l, signal).then((r) => {
            completed++;
            progress?.(
              completed,
              total,
              `${l.name} done (${completed}/${total})`,
            );
            return r;
          }),
        ),
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

      return successStructuredLarge({
        available: true,
        source: "cli",
        linters: availableLinters.map((l) => l.name),
        linterErrors: errors,
        summary,
        diagnostics: filteredDiags,
        ...(severityFilter ? { severityFilter } : {}),
        ...(filteredDiags.length < totalBeforeFilter
          ? { truncated: true, totalBeforeFilter }
          : {}),
      });
    },
  };
}
