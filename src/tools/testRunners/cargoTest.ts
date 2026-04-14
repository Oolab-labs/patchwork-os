import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafeStreaming } from "../utils.js";
import type { TestResult, TestRunner, TestStatus } from "./types.js";

const DEFAULT_TEST_TIMEOUT = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;

// Match: test module::test_name ... ok/FAILED/ignored
const RESULT_RE = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)/;
// Match: thread 'test_name' panicked at 'message', src/file.rs:42:5
const PANIC_RE = /panicked at\s+'(.+?)',\s*(.+?):(\d+):(\d+)/;
// Also handle newer Rust format (1.73+): panicked at src/file.rs:42:5:\nmessage
// The negative lookahead (?!') prevents this from matching old-style lines that
// start with a quoted message (e.g. when PANIC_RE fails due to a quote in the message).
// The file path must end in .rs or contain a path separator to avoid matching
// timestamps (e.g. "2024-01-01T00:00:00:123:456") as false positives.
const PANIC_NEW_RE =
  /panicked at\s+(?!')([^\s']\S*(?:\.rs|\/\S*))\s*:(\d+):(\d+)/;

export const cargoTestRunner: TestRunner = {
  name: "cargo-test",
  cacheTtl: 30000,

  detect(workspace: string, probes: ProbeResults): boolean {
    return probes.cargo && fs.existsSync(path.join(workspace, "Cargo.toml"));
  },

  async run(
    cwd: string,
    filter?: string,
    signal?: AbortSignal,
    timeoutMs?: number,
    onLine?: (line: string) => void,
  ): Promise<TestResult[]> {
    const args = ["test"];
    if (filter) {
      if (filter.startsWith("-"))
        throw new Error("filter must not start with '-'");
      args.push(filter);
    }
    args.push("--", "--color=never");
    // cargo test emits per-test results on stdout — stream those lines as progress.
    const result = await execSafeStreaming("cargo", args, {
      cwd,
      timeout: timeoutMs ?? DEFAULT_TEST_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      signal,
      onLine,
    });

    return parseOutput(`${result.stdout}\n${result.stderr}`, cwd);
  },
};

function parseOutput(output: string, cwd: string): TestResult[] {
  const results: TestResult[] = [];
  const lines = output.split("\n");
  const failedTests = new Set<string>();

  // First pass: collect all test result lines
  for (const line of lines) {
    const match = RESULT_RE.exec(line);
    if (!match) continue;

    const name = match[1] ?? "";
    const outcome = match[2] ?? "";
    let status: TestStatus = "passed";
    if (outcome === "FAILED") {
      status = "failed";
      failedTests.add(name);
    } else if (outcome === "ignored") {
      status = "skipped";
    }

    results.push({
      name,
      status,
      file: "",
      line: 1,
      column: 1,
      duration: 0,
      message: "",
      source: "cargo-test",
    });
  }

  // Second pass: extract panic locations for failed tests
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Try old-style panic format
    let panicMatch = PANIC_RE.exec(line);
    if (panicMatch) {
      const message = panicMatch[1] ?? "";
      const file = path.relative(cwd, path.resolve(cwd, panicMatch[2] ?? ""));
      const lineNum = Number.parseInt(panicMatch[3] ?? "0", 10);
      const col = Number.parseInt(panicMatch[4] ?? "0", 10);

      // Find the matching failed test result and update it
      const failResult = findNearestFailure(results, failedTests, file);
      if (failResult) {
        failResult.file = file;
        failResult.line = lineNum;
        failResult.column = col;
        failResult.message = message;
      }
      continue;
    }

    // Try new-style panic format
    panicMatch = PANIC_NEW_RE.exec(line);
    if (panicMatch) {
      const file = path.relative(cwd, path.resolve(cwd, panicMatch[1] ?? ""));
      const lineNum = Number.parseInt(panicMatch[2] ?? "0", 10);
      const col = Number.parseInt(panicMatch[3] ?? "0", 10);
      // Message is on the next line
      const message = lines[i + 1]?.trim() ?? "";

      const failResult = findNearestFailure(results, failedTests, file);
      if (failResult) {
        failResult.file = file;
        failResult.line = lineNum;
        failResult.column = col;
        failResult.message = message;
      }
    }
  }

  return results;
}

function findNearestFailure(
  results: TestResult[],
  failedTests: Set<string>,
  file: string,
): TestResult | null {
  // Prefer a failed test whose module path is a suffix of the file path
  // (e.g., file "src/foo.rs" matches test "foo::test_bar")
  const fileStem = file.replace(/\.rs$/, "").replace(/\//g, "::");
  for (const r of results) {
    if (r.status === "failed" && r.file === "" && failedTests.has(r.name)) {
      if (fileStem.endsWith(r.name.split("::")[0] ?? "")) {
        return r;
      }
    }
  }
  // Fallback: first unassigned failed test
  for (const r of results) {
    if (r.status === "failed" && r.file === "" && failedTests.has(r.name)) {
      return r;
    }
  }
  return null;
}
