import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import {
  error,
  optionalString,
  requireString,
  successStructured,
} from "./utils.js";

interface SourceFileCoverage {
  file: string;
  coveredLines: number;
  totalLines: number;
  pct: number;
  hotLines: number[];
}

/**
 * Parse lcov.info format.
 * Returns a map from source file path → { coveredLines, totalLines, hotLines }
 */
function parseLcov(
  content: string,
  workspace: string,
): Map<
  string,
  { coveredLines: number; totalLines: number; hotLines: number[] }
> {
  const result = new Map<
    string,
    { coveredLines: number; totalLines: number; hotLines: number[] }
  >();

  let currentFile: string | null = null;
  let coveredLines = 0;
  let totalLines = 0;
  const hotLines: number[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).trim();
      coveredLines = 0;
      totalLines = 0;
      hotLines.length = 0;
    } else if (line.startsWith("DA:") && currentFile !== null) {
      const parts = line.slice(3).split(",");
      const lineNo = Number.parseInt(parts[0] ?? "0", 10);
      const hits = Number.parseInt(parts[1] ?? "0", 10);
      if (!Number.isNaN(lineNo) && !Number.isNaN(hits)) {
        totalLines++;
        if (hits > 0) {
          coveredLines++;
          hotLines.push(lineNo);
        }
      }
    } else if (line === "end_of_record" && currentFile !== null) {
      // Normalise to workspace-relative path
      const relFile = currentFile.startsWith(workspace + path.sep)
        ? currentFile.slice(workspace.length + 1)
        : currentFile.startsWith(workspace + "/")
          ? currentFile.slice(workspace.length + 1)
          : currentFile;
      result.set(relFile, {
        coveredLines,
        totalLines,
        hotLines: [...hotLines],
      });
      currentFile = null;
    }
  }

  return result;
}

/**
 * Parse coverage-summary.json (istanbul/nyc/c8 format).
 * Returns similar map — no per-line data, so hotLines will be empty.
 */
function parseCoverageSummaryJson(
  content: string,
  workspace: string,
): Map<
  string,
  { coveredLines: number; totalLines: number; hotLines: number[] }
> {
  const result = new Map<
    string,
    { coveredLines: number; totalLines: number; hotLines: number[] }
  >();

  let json: Record<
    string,
    { lines?: { covered?: number; total?: number; pct?: number } }
  >;
  try {
    json = JSON.parse(content) as typeof json;
  } catch {
    return result;
  }

  for (const [key, val] of Object.entries(json)) {
    if (key === "total") continue;
    const relFile = key.startsWith(workspace + path.sep)
      ? key.slice(workspace.length + 1)
      : key.startsWith(workspace + "/")
        ? key.slice(workspace.length + 1)
        : key;
    const covered = val.lines?.covered ?? 0;
    const total = val.lines?.total ?? 0;
    result.set(relFile, {
      coveredLines: covered,
      totalLines: total,
      hotLines: [],
    });
  }

  return result;
}

export function createTestTraceToSourceTool(workspace: string) {
  return {
    schema: {
      name: "testTraceToSource",
      description:
        "Map a test pattern to covered source lines from lcov.info or coverage-summary.json — no instrumentation needed. Without per-test coverage, returns whole-suite coverage filtered by filename pattern.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["testPattern"],
        properties: {
          testPattern: {
            type: "string" as const,
            description:
              "Test name or filename pattern to match against coverage data",
          },
          coverageDir: {
            type: "string" as const,
            description:
              "Directory to search for coverage files (default: coverage/)",
          },
          minCoverage: {
            type: "number" as const,
            description:
              "Only show files at or above this line coverage % (default: 0)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        required: ["coverageFile", "sourceFiles", "note"],
        properties: {
          coverageFile: { type: "string" as const },
          sourceFiles: {
            type: "array" as const,
            items: {
              type: "object" as const,
              required: [
                "file",
                "coveredLines",
                "totalLines",
                "pct",
                "hotLines",
              ],
              properties: {
                file: { type: "string" as const },
                coveredLines: { type: "integer" as const },
                totalLines: { type: "integer" as const },
                pct: { type: "number" as const },
                hotLines: {
                  type: "array" as const,
                  items: { type: "integer" as const },
                },
              },
            },
          },
          note: { type: "string" as const },
        },
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      const testPattern = requireString(args, "testPattern");
      const coverageDirRaw = optionalString(args, "coverageDir") ?? "coverage";
      const minCoverageRaw = args.minCoverage;
      const minCoverage =
        typeof minCoverageRaw === "number" ? minCoverageRaw : 0;

      const coverageDir = path.isAbsolute(coverageDirRaw)
        ? coverageDirRaw
        : path.join(workspace, coverageDirRaw);

      if (!existsSync(coverageDir)) {
        return error(
          `Coverage directory not found: ${coverageDir}. Run tests with coverage first (e.g. npm test -- --coverage).`,
        );
      }

      // Prefer lcov.info over coverage-summary.json
      const lcovPath = path.join(coverageDir, "lcov.info");
      const summaryPath = path.join(coverageDir, "coverage-summary.json");

      let coverageFile: string;
      let coverageMap: Map<
        string,
        { coveredLines: number; totalLines: number; hotLines: number[] }
      >;
      let note: string;

      if (existsSync(lcovPath)) {
        const content = await fsPromises.readFile(lcovPath, "utf-8");
        coverageMap = parseLcov(content, workspace);
        coverageFile = lcovPath;
        note =
          "Coverage from lcov.info (whole test suite). For per-test tracing, run with jest --coverage-provider=v8 --testNamePattern or Istanbul --reporter=json. Pattern matched against source filenames.";
      } else if (existsSync(summaryPath)) {
        const content = await fsPromises.readFile(summaryPath, "utf-8");
        coverageMap = parseCoverageSummaryJson(content, workspace);
        coverageFile = summaryPath;
        note =
          "Coverage from coverage-summary.json (whole test suite, no per-line data). For per-test tracing, run with jest --coverage-provider=v8 --testNamePattern. Pattern matched against source filenames.";
      } else {
        return error(
          `No coverage file found in ${coverageDir}. Expected lcov.info or coverage-summary.json.`,
        );
      }

      // Filter by pattern (match against file path, case-insensitive)
      const patternLower = testPattern.toLowerCase();
      const sourceFiles: SourceFileCoverage[] = [];

      for (const [file, data] of coverageMap.entries()) {
        const fileLower = file.toLowerCase();
        // Match if file path contains any word from pattern
        const patternWords = patternLower.split(/[\s/._-]+/).filter(Boolean);
        const matches = patternWords.some((word) => fileLower.includes(word));
        if (!matches && patternLower !== "*" && patternLower !== "") continue;

        const pct =
          data.totalLines === 0
            ? 100
            : Math.round((data.coveredLines / data.totalLines) * 10000) / 100;

        if (pct < minCoverage) continue;

        sourceFiles.push({
          file,
          coveredLines: data.coveredLines,
          totalLines: data.totalLines,
          pct,
          hotLines: data.hotLines,
        });
      }

      // Sort by pct descending
      sourceFiles.sort((a, b) => b.pct - a.pct);

      return successStructured({ coverageFile, sourceFiles, note });
    },
  };
}
