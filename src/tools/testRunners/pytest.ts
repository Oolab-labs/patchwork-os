import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { TestResult, TestRunner } from "./types.js";

const TEST_TIMEOUT = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;

// Match: FAILED path/to/test.py::TestClass::test_name - message
// Anchor first group to .py to avoid capturing nested :: separators
const FAILED_RE = /^FAILED\s+(\S+\.py)::(.+?)(?:\s+-\s+(.+))?$/;
// Match: path/to/file.py:42: ErrorType: message
const TRACEBACK_RE = /^(.+?\.py):(\d+):\s+(.+)/;
// Match: X failed, Y passed, Z skipped (no g flag — used with .test() and fresh re for exec)
const SUMMARY_RE = /(\d+)\s+(failed|passed|skipped|error)/;

export const pytestRunner: TestRunner = {
  name: "pytest",
  cacheTtl: 30000,

  detect(workspace: string, probes: ProbeResults): boolean {
    if (!probes.pytest) return false;
    return (
      fs.existsSync(path.join(workspace, "pytest.ini")) ||
      fs.existsSync(path.join(workspace, "pyproject.toml")) ||
      fs.existsSync(path.join(workspace, "setup.cfg")) ||
      fs.existsSync(path.join(workspace, "conftest.py")) ||
      hasTestDir(workspace)
    );
  },

  async run(
    cwd: string,
    filter?: string,
    signal?: AbortSignal,
  ): Promise<TestResult[]> {
    const args = ["--tb=short", "-q"];
    if (filter) {
      if (filter.startsWith("-"))
        throw new Error("filter must not start with '-'");
      if (filter.includes(".."))
        throw new Error("filter must not contain path traversal");
      args.push("--", filter);
    }
    const result = await execSafe("pytest", args, {
      cwd,
      timeout: TEST_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      signal,
    });

    return parseOutput(`${result.stdout}\n${result.stderr}`, cwd);
  },
};

function hasTestDir(workspace: string): boolean {
  const testsDir = path.join(workspace, "tests");
  try {
    if (!fs.statSync(testsDir).isDirectory()) return false;
    return fs
      .readdirSync(testsDir)
      .some((f) => f.startsWith("test_") && f.endsWith(".py"));
  } catch {
    return false;
  }
}

function parseOutput(output: string, cwd: string): TestResult[] {
  const results: TestResult[] = [];
  const lines = output.split("\n");
  const failures = new Map<
    string,
    { file: string; name: string; message: string; line: number }
  >();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Match FAILED lines
    const failMatch = FAILED_RE.exec(line);
    if (failMatch) {
      const filePath = failMatch[1]!;
      const testName = failMatch[2]!;
      const message = failMatch[3] ?? "";
      const key = `${filePath}::${testName}`;
      failures.set(key, {
        file: path.relative(cwd, path.resolve(cwd, filePath)),
        name: testName,
        message,
        line: 1,
      });
      continue;
    }

    // Look for traceback lines to extract file:line for failures
    const tbMatch = TRACEBACK_RE.exec(line);
    if (tbMatch) {
      const tbFile = path.relative(cwd, path.resolve(cwd, tbMatch[1]!));
      const tbLine = Number.parseInt(tbMatch[2]!, 10);
      // Associate with the most recent failure whose file matches exactly
      for (const [, failure] of failures) {
        if (failure.line === 1 && failure.file === tbFile) {
          failure.line = tbLine;
          if (!failure.message) failure.message = tbMatch[3] ?? "";
          break;
        }
      }
    }
  }

  // Convert failures to results
  for (const [, f] of failures) {
    results.push({
      name: f.name,
      status: "failed",
      file: f.file,
      line: f.line,
      column: 1,
      duration: 0,
      message: f.message,
      source: "pytest",
    });
  }

  // Try to extract passed/skipped counts from summary line
  const summaryLine = lines.find((l) => SUMMARY_RE.test(l));
  if (summaryLine) {
    let match: RegExpExecArray | null;
    const counts: Record<string, number> = {};
    const re = /(\d+)\s+(failed|passed|skipped|error)/g;
    while ((match = re.exec(summaryLine)) !== null) {
      counts[match[2]!] = Number.parseInt(match[1]!, 10);
    }
    // Add placeholder passed results for summary (no file:line for passed tests in -q output)
    const passedCount =
      (counts.passed ?? 0) -
      results.filter((r) => r.status === "passed").length;
    for (let j = 0; j < passedCount; j++) {
      results.push({
        name: `passed_test_${j + 1}`,
        status: "passed",
        file: "",
        line: 1,
        column: 1,
        duration: 0,
        message: "",
        source: "pytest",
      });
    }
  }

  return results;
}
