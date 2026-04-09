import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { error, optionalString, successStructuredLarge } from "./utils.js";

interface FileCoverageEntry {
  file: string;
  lines: number;
  branches: number | null;
  functions: number | null;
}

function pct(hit: number, found: number): number {
  if (found === 0) return 100;
  return Math.round((hit / found) * 10000) / 100;
}

function parseCoverageSummary(
  content: string,
  workspace: string,
): FileCoverageEntry[] {
  const json = JSON.parse(content) as Record<
    string,
    {
      lines?: { pct?: number };
      branches?: { pct?: number };
      functions?: { pct?: number };
    }
  >;
  const entries: FileCoverageEntry[] = [];
  for (const [key, val] of Object.entries(json)) {
    if (key === "total") continue;
    const relFile = key.startsWith(workspace + path.sep)
      ? key.slice(workspace.length + 1)
      : key;
    entries.push({
      file: relFile,
      lines: val.lines?.pct ?? 0,
      branches: val.branches?.pct ?? null,
      functions: val.functions?.pct ?? null,
    });
  }
  return entries;
}

function parseLcov(content: string): FileCoverageEntry[] {
  const entries: FileCoverageEntry[] = [];
  const records = content.split(/\nend_of_record\r?\n?/);
  for (const record of records) {
    const lines = record.split("\n");
    let filePath = "";
    let lh = 0;
    let lf = 0;
    let brh = 0;
    let brf = 0;
    let fnh = 0;
    let fnf = 0;
    for (const line of lines) {
      if (line.startsWith("SF:")) filePath = line.slice(3).trim();
      else if (line.startsWith("LH:")) lh = Number.parseInt(line.slice(3), 10);
      else if (line.startsWith("LF:")) lf = Number.parseInt(line.slice(3), 10);
      else if (line.startsWith("BRH:"))
        brh = Number.parseInt(line.slice(4), 10);
      else if (line.startsWith("BRF:"))
        brf = Number.parseInt(line.slice(4), 10);
      else if (line.startsWith("FNH:"))
        fnh = Number.parseInt(line.slice(4), 10);
      else if (line.startsWith("FNF:"))
        fnf = Number.parseInt(line.slice(4), 10);
    }
    if (!filePath) continue;
    entries.push({
      file: filePath,
      lines: pct(lh, lf),
      branches: brf > 0 ? pct(brh, brf) : null,
      functions: fnf > 0 ? pct(fnh, fnf) : null,
    });
  }
  return entries;
}

function parseClover(content: string): FileCoverageEntry[] {
  const entries: FileCoverageEntry[] = [];
  // Match <file name="..."> followed by <metrics .../>
  const fileRe = /<file\s+name="([^"]+)"[^>]*>[\s\S]*?<metrics\s([^/]*)\//g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(content)) !== null) {
    const filePath = m[1] ?? "";
    const attrs = m[2] ?? "";

    const getAttr = (name: string): number => {
      const a = new RegExp(`${name}="(\\d+)"`).exec(attrs);
      return a ? Number.parseInt(a[1] ?? "0", 10) : 0;
    };

    const statements = getAttr("statements");
    const coveredStatements = getAttr("coveredstatements");
    const conditionals = getAttr("conditionals");
    const coveredConditionals = getAttr("coveredconditionals");
    const methods = getAttr("methods");
    const coveredMethods = getAttr("coveredmethods");

    entries.push({
      file: filePath,
      lines: pct(coveredStatements, statements),
      branches:
        conditionals > 0 ? pct(coveredConditionals, conditionals) : null,
      functions: methods > 0 ? pct(coveredMethods, methods) : null,
    });
  }
  return entries;
}

export function createGetCodeCoverageTool(workspace: string) {
  return {
    schema: {
      name: "getCodeCoverage",
      description:
        "Parse an existing coverage report (lcov.info, coverage-summary.json, or clover.xml) and return per-file line/branch/function coverage percentages. " +
        "Does not run tests — parses the most recent report.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          file: {
            type: "string",
            description:
              "Path to coverage report. If omitted, auto-detects in coverage/",
          },
          minCoverage: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description: "Filter: only return files below this coverage %",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          reportFile: { type: "string" },
          format: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                lines: { type: "number" },
                branches: { type: ["number", "null"] },
                functions: { type: ["number", "null"] },
              },
              required: ["file", "lines"],
            },
          },
          summary: {
            type: "object",
            properties: {
              totalFiles: { type: "integer" },
              averageLineCoverage: { type: "number" },
              belowThreshold: { type: "integer" },
            },
          },
        },
        required: ["reportFile", "format", "files", "summary"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const fileArg = optionalString(args, "file");
      const minCoverage =
        typeof args.minCoverage === "number" ? args.minCoverage : 0;

      let reportFile: string;
      if (fileArg) {
        reportFile = path.isAbsolute(fileArg)
          ? fileArg
          : path.resolve(workspace, fileArg);
      } else {
        const candidates = [
          path.join(workspace, "coverage", "coverage-summary.json"),
          path.join(workspace, "coverage", "lcov.info"),
          path.join(workspace, ".nyc_output", "coverage-summary.json"),
          path.join(workspace, "coverage", "clover.xml"),
        ];
        const found = candidates.find((c) => existsSync(c));
        if (!found) {
          return error(
            "No coverage report found. Run your test suite with coverage first (e.g. npm test -- --coverage).",
          );
        }
        reportFile = found;
      }

      let content: string;
      try {
        content = await fsPromises.readFile(reportFile, "utf-8");
      } catch {
        return error(`Cannot read coverage report: ${reportFile}`);
      }

      const basename = path.basename(reportFile);
      let format: string;
      let files: FileCoverageEntry[];

      try {
        if (basename === "coverage-summary.json") {
          format = "coverage-summary";
          files = parseCoverageSummary(content, workspace);
        } else if (basename === "lcov.info") {
          format = "lcov";
          files = parseLcov(content);
        } else if (basename === "clover.xml") {
          format = "clover";
          files = parseClover(content);
        } else {
          // Try to detect by content
          if (content.trimStart().startsWith("{")) {
            format = "coverage-summary";
            files = parseCoverageSummary(content, workspace);
          } else if (content.includes("SF:")) {
            format = "lcov";
            files = parseLcov(content);
          } else if (content.includes("<coverage")) {
            format = "clover";
            files = parseClover(content);
          } else {
            return error(
              `Unknown coverage report format for file: ${reportFile}`,
            );
          }
        }
      } catch (err) {
        return error(
          `Failed to parse coverage report: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Filter
      const filtered =
        minCoverage > 0 ? files.filter((f) => f.lines < minCoverage) : files;

      // Sort by lines pct ascending (worst first)
      filtered.sort((a, b) => a.lines - b.lines);

      const totalFiles = filtered.length;
      const averageLineCoverage =
        totalFiles > 0
          ? Math.round(
              (filtered.reduce((sum, f) => sum + f.lines, 0) / totalFiles) *
                100,
            ) / 100
          : 0;
      const belowThreshold =
        minCoverage > 0
          ? filtered.length
          : files.filter((f) => f.lines < 80).length;

      return successStructuredLarge({
        reportFile,
        format,
        files: filtered,
        summary: {
          totalFiles,
          averageLineCoverage,
          belowThreshold,
        },
      });
    },
  };
}
