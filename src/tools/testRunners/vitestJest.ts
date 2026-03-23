import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { TestResult, TestRunner, TestStatus } from "./types.js";

const TEST_TIMEOUT = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;

interface JsonTestResult {
  fullName?: string;
  ancestorTitles?: string[];
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
  location?: { line?: number; column?: number };
}

interface JsonTestFile {
  testFilePath?: string;
  testResults?: JsonTestResult[];
}

interface JsonReport {
  testResults?: JsonTestFile[];
}

function extractLineFromStack(
  stack: string,
): { line: number; column: number } | null {
  // Match "at ... (file:line:col)" or "at file:line:col"
  const match = stack.match(/at\s+.*?[(/]([^):\s]+):(\d+):(\d+)/);
  if (match) {
    return {
      line: Number.parseInt(match[2] ?? "0", 10),
      column: Number.parseInt(match[3] ?? "0", 10),
    };
  }
  return null;
}

function parseJsonReport(
  stdout: string,
  workspace: string,
  source: string,
): TestResult[] {
  // Search for the JSON report by looking for known top-level keys first,
  // then falling back to scanning { positions. This avoids O(n^2) on large output.
  let report: JsonReport | null = null;

  // Helper: return a parsed object only if it looks like a test report
  const isReport = (obj: unknown): obj is JsonReport =>
    typeof obj === "object" &&
    obj !== null &&
    Array.isArray((obj as JsonReport).testResults);

  // Fast path: look for known JSON report markers.
  // Try both the first and last occurrence — some reporters prepend preamble JSON
  // (e.g. a setup script logging {"testResults":"none"}) before the real report.
  const markers = [
    '{"numTotalTestSuites"',
    '{"testResults"',
    '{"numFailedTestSuites"',
  ];
  for (const marker of markers) {
    for (const searchFn of [
      (s: string) => s.indexOf(marker),
      (s: string) => s.lastIndexOf(marker),
    ]) {
      const idx = searchFn(stdout);
      if (idx !== -1) {
        try {
          const parsed = JSON.parse(stdout.slice(idx));
          if (isReport(parsed)) {
            report = parsed;
            break;
          }
        } catch {
          // parse failed — continue
        }
      }
    }
    if (report) break;
  }

  // Slow path: scan from each { position (capped at 20 attempts to avoid O(n^2)).
  // Each failed attempt advances past the current { so we make forward progress.
  if (!report) {
    let searchFrom = 0;
    let attempts = 0;
    while (searchFrom < stdout.length && attempts < 20) {
      const start = stdout.indexOf("{", searchFrom);
      if (start === -1) break;
      try {
        const parsed = JSON.parse(stdout.slice(start));
        if (isReport(parsed)) {
          report = parsed;
          break;
        }
        // Valid JSON but wrong shape — skip past this {
        searchFrom = start + 1;
      } catch {
        searchFrom = start + 1;
      }
      attempts++;
    }
  }
  if (!report) return [];

  const results: TestResult[] = [];
  for (const file of report.testResults ?? []) {
    const filePath = file.testFilePath
      ? path.relative(workspace, file.testFilePath)
      : "";

    for (const test of file.testResults ?? []) {
      const name = test.fullName ?? test.title ?? "unknown";
      let status: TestStatus = "passed";
      if (test.status === "failed") status = "failed";
      else if (test.status === "pending") status = "skipped";

      let line = test.location?.line ?? 1;
      let column = test.location?.column ?? 1;
      let message = "";

      if (status === "failed" && test.failureMessages?.length) {
        message = test.failureMessages.join("\n").slice(0, 2000);
        if (line === 1) {
          const loc = extractLineFromStack(message);
          if (loc) {
            line = loc.line;
            column = loc.column;
          }
        }
      }

      results.push({
        name,
        status,
        file: filePath,
        line,
        column,
        duration: test.duration ?? 0,
        message,
        source,
      });
    }
  }
  return results;
}

function hasDevDep(workspace: string, pkg: string): boolean {
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(workspace, "package.json"), "utf-8"),
    );
    return !!(pkgJson.devDependencies?.[pkg] || pkgJson.dependencies?.[pkg]);
  } catch {
    return false;
  }
}

function hasAnyConfig(workspace: string, names: string[]): boolean {
  return names.some((n) => fs.existsSync(path.join(workspace, n)));
}

function resolveLocalBin(cwd: string, bin: string): string | null {
  const localPath = path.join(cwd, "node_modules", ".bin", bin);
  if (fs.existsSync(localPath)) return localPath;
  return null;
}

export const vitestRunner: TestRunner = {
  name: "vitest",
  cacheTtl: 30000,

  detect(workspace: string, probes: ProbeResults): boolean {
    if (!probes.vitest && !hasDevDep(workspace, "vitest")) return false;
    return (
      hasAnyConfig(workspace, [
        "vitest.config.ts",
        "vitest.config.js",
        "vitest.config.mts",
        "vitest.config.mjs",
      ]) || hasDevDep(workspace, "vitest")
    );
  },

  async run(
    cwd: string,
    filter?: string,
    signal?: AbortSignal,
  ): Promise<TestResult[]> {
    // Prefer local node_modules/.bin to avoid npx auto-downloading packages
    const bin = resolveLocalBin(cwd, "vitest");
    const cmd = bin ?? "npx";
    const args = bin
      ? ["run", "--reporter=json"]
      : ["--no", "vitest", "run", "--reporter=json"];
    if (filter) args.push("--", filter);
    const result = await execSafe(cmd, args, {
      cwd,
      timeout: TEST_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      signal,
    });
    // exitCode 127 = command not found; null = killed by signal
    if (result.exitCode === 127 || result.exitCode === null) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `vitest runner failed (exit ${result.exitCode ?? "signal"})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return parseJsonReport(result.stdout, cwd, "vitest");
  },
};

export const jestRunner: TestRunner = {
  name: "jest",
  cacheTtl: 30000,

  detect(workspace: string, probes: ProbeResults): boolean {
    if (!probes.jest && !hasDevDep(workspace, "jest")) return false;
    return (
      hasAnyConfig(workspace, [
        "jest.config.js",
        "jest.config.ts",
        "jest.config.cjs",
        "jest.config.mjs",
      ]) || hasDevDep(workspace, "jest")
    );
  },

  async run(
    cwd: string,
    filter?: string,
    signal?: AbortSignal,
  ): Promise<TestResult[]> {
    // Prefer local node_modules/.bin to avoid npx auto-downloading packages
    const bin = resolveLocalBin(cwd, "jest");
    const cmd = bin ?? "npx";
    const args = bin
      ? ["--json", "--forceExit"]
      : ["--no", "jest", "--json", "--forceExit"];
    if (filter) args.push("--", filter);
    const result = await execSafe(cmd, args, {
      cwd,
      timeout: TEST_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      signal,
    });
    // exitCode 127 = command not found; null = killed by signal
    if (result.exitCode === 127 || result.exitCode === null) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(
        `jest runner failed (exit ${result.exitCode ?? "signal"})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return parseJsonReport(result.stdout, cwd, "jest");
  },
};
