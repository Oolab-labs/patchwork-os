import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Diagnostic,
  ExtensionClient,
  TabInfo,
} from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import { runGitStdout } from "./git-utils.js";
import { execSafe, successStructured } from "./utils.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24 hours
const MAX_ERRORS = 5;
const MAX_COMMITS = 5;
const MAX_MODULES = 20;
const MAX_OPEN_FILES = 10;

interface CachedBrief {
  generatedAt: string;
  workspace: string;
  brief: ProjectBrief;
  topModulesSource?: TopModulesSource;
  ctagsStatus?: CtagsStatus;
}

interface ProjectBrief {
  activeFile: string | null;
  recentErrors: Array<{ file: string; message: string; severity: string }>;
  recentCommits: Array<{ hash: string; message: string; author: string }>;
  topModules: string[];
  openFiles: string[];
  diagnosticSummary: string;
}

type TopModulesSource = "ctags" | "filesystem";
type CtagsStatus = "success" | "not_available" | "failed";

function cacheKey(workspace: string): string {
  return crypto
    .createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, 12);
}

function cacheFilePath(workspace: string): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(
    configDir,
    "ide",
    `context-cache-${cacheKey(workspace)}.json`,
  );
}

function readCache(workspace: string, maxAgeMs: number): CachedBrief | null {
  try {
    const p = cacheFilePath(workspace);
    const raw = fs.readFileSync(p, "utf-8");
    const cached = JSON.parse(raw) as CachedBrief;
    const age = Date.now() - new Date(cached.generatedAt).getTime();
    if (age > maxAgeMs) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(
  workspace: string,
  brief: ProjectBrief,
  topModulesSource?: TopModulesSource,
  ctagsStatus?: CtagsStatus,
): void {
  try {
    const p = cacheFilePath(workspace);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const entry: CachedBrief = {
      generatedAt: new Date().toISOString(),
      workspace,
      brief,
      topModulesSource,
      ctagsStatus,
    };
    fs.writeFileSync(p, JSON.stringify(entry, null, 2), "utf-8");
  } catch {
    // Non-fatal — cache write failure doesn't break the tool
  }
}

/**
 * getProjectContext — cached session-start context brief.
 *
 * Returns a lightweight summary of the project (active file, errors, recent
 * commits, top modules) that Claude can inject at session start to skip
 * codebase re-exploration. Brief is cached for 24 hours (configurable) and
 * can be force-invalidated with force=true.
 */
export function createGetProjectContextTool(
  workspace: string,
  extensionClient: ExtensionClient,
  probes: ProbeResults,
  opts?: { onCacheUpdated?: (generatedAt: string) => void },
) {
  return {
    schema: {
      name: "getProjectContext",
      description:
        "Cached session-start brief: active file, errors, recent commits, modules. Skips cold-start re-exploration.",
      annotations: { readOnlyHint: true },
      cache_control: { type: "ephemeral" as const },
      inputSchema: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          maxAgeMs: {
            type: "integer" as const,
            description:
              "Cache TTL in milliseconds. Default: 86400000 (24 hours).",
            minimum: 0,
          },
          force: {
            type: "boolean" as const,
            description: "Bypass cache and regenerate. Default: false.",
          },
          sections: {
            type: "array" as const,
            description:
              'Sections to include. Default: ["all"]. Options: files, errors, git, modules, all.',
            items: {
              type: "string" as const,
              enum: ["files", "errors", "git", "modules", "all"] as const,
            },
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          generatedAt: { type: "string" },
          fromCache: { type: "boolean" },
          brief: {
            type: "object",
            properties: {
              activeFile: { type: ["string", "null"] },
              recentErrors: { type: "array" },
              recentCommits: { type: "array" },
              topModules: { type: "array" },
              openFiles: { type: "array" },
              diagnosticSummary: { type: "string" },
            },
            required: [
              "activeFile",
              "recentErrors",
              "recentCommits",
              "topModules",
              "openFiles",
              "diagnosticSummary",
            ],
          },
          memoryGraphQueries: { type: "array" },
          suggestedPrompt: { type: "string" },
          hint: { type: "string" },
          topModulesSource: { type: "string", enum: ["ctags", "filesystem"] },
          ctagsStatus: {
            type: "string",
            enum: ["success", "not_available", "failed"],
          },
        },
        required: ["workspace", "generatedAt", "fromCache", "brief", "hint"],
      },
    },

    handler: async (params: {
      maxAgeMs?: number;
      force?: boolean;
      sections?: string[];
    }) => {
      const maxAgeMs =
        typeof params.maxAgeMs === "number" && params.maxAgeMs >= 0
          ? params.maxAgeMs
          : DEFAULT_MAX_AGE_MS;
      const force = params.force === true;
      const sections = params.sections ?? ["all"];
      const includeAll = sections.includes("all");
      const includeFiles = includeAll || sections.includes("files");
      const includeErrors = includeAll || sections.includes("errors");
      const includeGit = includeAll || sections.includes("git");
      const includeModules = includeAll || sections.includes("modules");

      // Fast path: return cached brief
      if (!force) {
        const cached = readCache(workspace, maxAgeMs);
        if (cached) {
          return successStructured({
            workspace,
            generatedAt: cached.generatedAt,
            fromCache: true,
            brief: cached.brief,
            suggestedPrompt: buildSuggestedPrompt(cached.brief),
            hint: buildHint(cached.ctagsStatus ?? "not_available"),
            topModulesSource: cached.topModulesSource ?? "filesystem",
            ctagsStatus: cached.ctagsStatus ?? "not_available",
          });
        }
      }

      // Slow path: build fresh brief
      let topModulesSource: TopModulesSource = "filesystem";
      let ctagsStatus: CtagsStatus = probes.universalCtags
        ? "failed"
        : "not_available";

      const brief: ProjectBrief = {
        activeFile: null,
        recentErrors: [],
        recentCommits: [],
        topModules: [],
        openFiles: [],
        diagnosticSummary: "No data",
      };

      const connected = extensionClient.isConnected();

      const [diagnosticsResult, openFilesResult, gitLogResult, ctagsResult] =
        await Promise.allSettled([
          // Diagnostics (errors/warnings)
          includeErrors && connected
            ? extensionClient.getDiagnostics()
            : Promise.resolve(null),

          // Open file list
          includeFiles && connected
            ? extensionClient.getOpenFiles()
            : Promise.resolve(null),

          // Recent git commits
          includeGit
            ? runGitStdout(
                ["log", "--format=%H|%an|%s", `-${MAX_COMMITS}`],
                workspace,
              )
            : Promise.resolve(""),

          // Top modules via ctags
          includeModules && probes.universalCtags
            ? execSafe(
                "ctags",
                [
                  "--output-format=json",
                  "-R",
                  "--fields=+n",
                  "--languages=TypeScript,JavaScript,Python,Go,Rust",
                  workspace,
                ],
                { timeout: 8_000 },
              )
            : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
        ]);

      // Active file (from live extension state — no request needed)
      if (includeFiles && extensionClient.latestActiveFile) {
        brief.activeFile = extensionClient.latestActiveFile;
      }

      // Open files
      if (
        includeFiles &&
        openFilesResult.status === "fulfilled" &&
        Array.isArray(openFilesResult.value)
      ) {
        brief.openFiles = (openFilesResult.value as TabInfo[])
          .map((t) => t.filePath)
          .slice(0, MAX_OPEN_FILES);
      }

      // Diagnostics
      if (
        includeErrors &&
        diagnosticsResult.status === "fulfilled" &&
        Array.isArray(diagnosticsResult.value)
      ) {
        const allDiags = diagnosticsResult.value as Diagnostic[];
        const errorsAndWarnings = allDiags.filter(
          (d) => d.severity === "error" || d.severity === "warning",
        );
        brief.recentErrors = errorsAndWarnings
          .slice(0, MAX_ERRORS)
          .map((d) => ({
            file: d.file,
            message: d.message,
            severity: d.severity,
          }));
        const errCount = allDiags.filter((d) => d.severity === "error").length;
        const warnCount = allDiags.filter(
          (d) => d.severity === "warning",
        ).length;
        brief.diagnosticSummary =
          errCount > 0 || warnCount > 0
            ? `${errCount} error(s), ${warnCount} warning(s)`
            : "No errors or warnings";
      }

      // Git commits
      if (includeGit && gitLogResult.status === "fulfilled") {
        const lines = gitLogResult.value.trim().split("\n").filter(Boolean);
        brief.recentCommits = lines.slice(0, MAX_COMMITS).map((line) => {
          const parts = line.split("|");
          return {
            hash: (parts[0] ?? "").slice(0, 7),
            author: parts[1] ?? "",
            message: parts[2] ?? "",
          };
        });
      }

      // Modules via ctags
      if (
        includeModules &&
        ctagsResult.status === "fulfilled" &&
        ctagsResult.value.stdout
      ) {
        const moduleSet = new Set<string>();
        for (const line of ctagsResult.value.stdout.trim().split("\n")) {
          try {
            const tag = JSON.parse(line) as {
              kind?: string;
              name?: string;
              path?: string;
            };
            if (tag.kind === "module" && tag.path) {
              const rel = path.relative(workspace, tag.path);
              const dir = rel.split("/")[0];
              if (dir && !dir.startsWith(".") && dir !== "node_modules") {
                moduleSet.add(dir);
              }
            }
          } catch {
            // malformed ctags line — skip
          }
        }
        brief.topModules = Array.from(moduleSet).slice(0, MAX_MODULES);
        if (brief.topModules.length > 0) {
          topModulesSource = "ctags";
          ctagsStatus = "success";
        }
      }

      // Fallback module discovery from filesystem top-level dirs
      if (includeModules && brief.topModules.length === 0) {
        try {
          const entries = fs.readdirSync(workspace, { withFileTypes: true });
          brief.topModules = entries
            .filter(
              (e) =>
                e.isDirectory() &&
                !e.name.startsWith(".") &&
                e.name !== "node_modules" &&
                e.name !== "dist",
            )
            .map((e) => e.name)
            .slice(0, MAX_MODULES);
        } catch {
          // workspace not readable — leave empty
        }
      }

      // Build codebase-memory query hints
      const projectId = workspace.replace(/\//g, "-").replace(/^-/, "");
      const memoryGraphQueries = [
        {
          tool: "mcp__codebase-memory__get_architecture",
          params: { projectId },
          hint: "Module boundaries and service topology",
        },
        {
          tool: "mcp__codebase-memory__query_graph",
          params: {
            projectId,
            query:
              "MATCH (f:File)-[r:FILE_CHANGES_WITH]->(g:File) RETURN f,r,g ORDER BY r.count DESC LIMIT 10",
          },
          hint: "Files that change together (hotspots)",
        },
      ];

      const generatedAt = new Date().toISOString();
      writeCache(workspace, brief, topModulesSource, ctagsStatus);
      opts?.onCacheUpdated?.(generatedAt);

      return successStructured({
        workspace,
        generatedAt,
        fromCache: false,
        brief,
        memoryGraphQueries,
        suggestedPrompt: buildSuggestedPrompt(brief),
        hint: buildHint(ctagsStatus),
        topModulesSource,
        ctagsStatus,
      });
    },
  };
}

function buildSuggestedPrompt(brief: ProjectBrief): string {
  const parts: string[] = [];
  if (brief.activeFile) {
    parts.push(`I'm working in ${brief.activeFile}.`);
  }
  if (brief.recentErrors.length > 0) {
    parts.push(
      `There are ${brief.recentErrors.length} error(s)/warning(s) in the workspace.`,
    );
  }
  if (brief.recentCommits.length > 0) {
    const c = brief.recentCommits[0];
    if (c) {
      parts.push(`Last commit: "${c.message}" by ${c.author}.`);
    }
  }
  if (brief.topModules.length > 0) {
    parts.push(`Key modules: ${brief.topModules.slice(0, 5).join(", ")}.`);
  }
  parts.push("Start here instead of re-exploring the codebase.");
  return parts.join(" ");
}

function buildHint(ctagsStatus: CtagsStatus): string {
  const ctagsHint =
    ctagsStatus !== "success"
      ? " Install ctags for better module discovery: brew install universal-ctags."
      : "";
  return (
    "Inject this brief at session start to skip codebase exploration. " +
    "Use suggestedPrompt as a ready-made context sentence. " +
    "Call with force=true to invalidate after major refactors. " +
    "If codebase-memory MCP is connected, run memoryGraphQueries for deeper architectural context." +
    ctagsHint
  );
}
