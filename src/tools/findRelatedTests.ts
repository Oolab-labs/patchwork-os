import path from "node:path";
import type { ProbeResults } from "../probe.js";
import {
  execSafe,
  makeRelative,
  optionalBool,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

/**
 * findRelatedTests — semantic test discovery composite tool.
 *
 * Given a source file, finds test files that reference it via:
 * 1. Name-pattern matching (*.test.ts, *.spec.ts adjacent to the file)
 * 2. ripgrep content search — test files that import or require the source file
 *
 * Optionally cross-references coverage data to show which lines are uncovered.
 * Returns ranked list of test files with import evidence and coverage summary.
 */
export function createFindRelatedTestsTool(
  workspace: string,
  probes: ProbeResults,
) {
  return {
    schema: {
      name: "findRelatedTests",
      description:
        "Find test files that cover a source file via import search + name patterns. " +
        "Optionally includes coverage pct per test file.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string" as const,
            description:
              "Source file to find tests for (absolute or workspace-relative)",
          },
          includeCoverage: {
            type: "boolean" as const,
            description:
              "Cross-reference coverage report if available (default: false)",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          sourceFile: { type: "string" },
          testFiles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                matchReason: { type: "string" },
                importLine: { type: "string" },
                coveragePct: { anyOf: [{ type: "number" }, { type: "null" }] },
              },
              required: ["file", "matchReason"],
            },
          },
          totalFound: { type: "integer" },
          coverageAvailable: { type: "boolean" },
          memoryGraphHint: { type: "string" },
        },
        required: [
          "sourceFile",
          "testFiles",
          "totalFound",
          "coverageAvailable",
        ],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);
      const relSource = makeRelative(filePath, workspace);
      const includeCoverage = optionalBool(args, "includeCoverage") ?? false;

      const baseName = path.basename(filePath, path.extname(filePath));
      const dir = path.dirname(filePath);
      const relDir = makeRelative(dir, workspace);

      const testFiles = new Map<
        string,
        { matchReason: string; importLine?: string }
      >();

      // Step 1 — name-pattern search: look for <name>.test.* and <name>.spec.*
      const namePatterns = [
        `${baseName}.test.*`,
        `${baseName}.spec.*`,
        `${baseName}-test.*`,
        `${baseName}_test.*`,
      ];

      for (const pattern of namePatterns) {
        const result = probes.rg
          ? await execSafe("rg", ["--files", "--glob", pattern, workspace], {
              cwd: workspace,
              signal,
              timeout: 5_000,
              maxBuffer: 512 * 1024,
            })
          : await execSafe("find", [workspace, "-name", pattern], {
              cwd: workspace,
              signal,
              timeout: 5_000,
              maxBuffer: 512 * 1024,
            });

        if (result.exitCode === 0) {
          for (const line of result.stdout.split("\n")) {
            const f = line.trim();
            if (f && !testFiles.has(f)) {
              testFiles.set(f, { matchReason: "name-pattern" });
            }
          }
        }
      }

      // Step 2 — import search via rg: find test files that import the source
      if (probes.rg) {
        // Search for imports of the source file by relative path or bare module name
        const importPatterns = [
          `from ['"].*${baseName}['"]`,
          `require\\(['"].*${baseName}['"]\\)`,
          relDir !== "." ? relSource.replace(/\\/g, "/") : baseName,
        ];

        for (const pattern of importPatterns) {
          const rgResult = await execSafe(
            "rg",
            [
              "--glob",
              "*.test.*",
              "--glob",
              "*.spec.*",
              "--with-filename",
              "--line-number",
              "-e",
              pattern,
              workspace,
            ],
            { cwd: workspace, signal, timeout: 8_000, maxBuffer: 1024 * 1024 },
          );

          if (rgResult.exitCode === 0) {
            for (const line of rgResult.stdout.split("\n")) {
              const match = line.match(/^(.+?):(\d+):(.+)$/);
              if (match) {
                const [, file, , importLine] = match;
                if (file && !testFiles.has(file)) {
                  testFiles.set(file, {
                    matchReason: "import-reference",
                    importLine: importLine?.trim().slice(0, 120),
                  });
                }
              }
            }
          }
        }
      }

      // Step 3 — optionally load coverage data
      let coverageByFile: Map<string, number> | null = null;
      if (includeCoverage) {
        const { promises: fs } = await import("node:fs");
        const candidates = [
          path.join(workspace, "coverage", "coverage-summary.json"),
          path.join(workspace, "coverage", "lcov.info"),
        ];
        for (const candidate of candidates) {
          try {
            const content = await fs.readFile(candidate, "utf-8");
            coverageByFile = new Map();
            if (candidate.endsWith(".json")) {
              const json = JSON.parse(content) as Record<
                string,
                { lines?: { pct?: number } }
              >;
              for (const [key, val] of Object.entries(json)) {
                if (key !== "total")
                  coverageByFile.set(key, val.lines?.pct ?? 0);
              }
            }
            break;
          } catch {
            // try next candidate
          }
        }
      }

      // Build result list
      const results = Array.from(testFiles.entries())
        .slice(0, 30)
        .map(([file, meta]) => {
          const relFile = makeRelative(file, workspace);
          const coveragePct =
            coverageByFile?.get(file) ?? coverageByFile?.get(relFile) ?? null;
          return {
            file: relFile,
            matchReason: meta.matchReason,
            ...(meta.importLine ? { importLine: meta.importLine } : {}),
            ...(includeCoverage ? { coveragePct } : {}),
          };
        })
        // name-pattern matches first, then import-reference
        .sort((a, b) =>
          a.matchReason === "name-pattern"
            ? -1
            : b.matchReason === "name-pattern"
              ? 1
              : 0,
        );

      return successStructured({
        sourceFile: relSource,
        testFiles: results,
        totalFound: results.length,
        coverageAvailable: coverageByFile !== null,
        memoryGraphHint:
          `For deeper semantic test discovery, query codebase-memory: ` +
          `mcp__codebase-memory__search_graph with pattern "${baseName}" ` +
          `to find test nodes linked via CALLS or IMPORTS edges.`,
      });
    },
  };
}
