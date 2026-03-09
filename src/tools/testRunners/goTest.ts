import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { TestResult, TestRunner, TestStatus } from "./types.js";

const TEST_TIMEOUT = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;

// Match: file_test.go:42: message
const FILE_LINE_RE = /(\S+_test\.go):(\d+):\s*(.*)/;

interface TestEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
  Elapsed?: number;
}

export const goTestRunner: TestRunner = {
  name: "go-test",
  cacheTtl: 30000,

  detect(workspace: string, probes: ProbeResults): boolean {
    return probes.go && fs.existsSync(path.join(workspace, "go.mod"));
  },

  async run(cwd: string, filter?: string, signal?: AbortSignal): Promise<TestResult[]> {
    const args = ["test", "-json", "-count=1", "./..."];
    if (filter) {
      if (filter.startsWith("-")) throw new Error("filter must not start with '-'");
      args.splice(3, 0, "-run", filter);
    }
    const result = await execSafe("go", args, {
      cwd,
      timeout: TEST_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      signal,
    });

    return parseNdjson(result.stdout, cwd);
  },
};

function parseNdjson(stdout: string, cwd: string): TestResult[] {
  const results: TestResult[] = [];
  // Accumulate output per test
  const outputs = new Map<string, string[]>();
  const durations = new Map<string, number>();

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: TestEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip package-level events (no Test field)
    if (!event.Test) continue;

    const key = `${event.Package ?? ""}/${event.Test}`;

    if (event.Action === "output" && event.Output) {
      const existing = outputs.get(key) ?? [];
      existing.push(event.Output);
      outputs.set(key, existing);
    }

    if (event.Elapsed !== undefined) {
      durations.set(key, Math.round(event.Elapsed * 1000));
    }

    if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") {
      let status: TestStatus = "passed";
      if (event.Action === "fail") status = "failed";
      else if (event.Action === "skip") status = "skipped";

      const outputLines = outputs.get(key) ?? [];
      const { file, lineNum, message } = extractLocation(outputLines, cwd);

      results.push({
        name: event.Test,
        status,
        file,
        line: lineNum,
        column: 1,
        duration: durations.get(key) ?? (event.Elapsed ? Math.round(event.Elapsed * 1000) : 0),
        message: status === "failed" ? message : "",
        source: "go-test",
      });
    }
  }

  return results;
}

function extractLocation(
  outputLines: string[],
  cwd: string,
): { file: string; lineNum: number; message: string } {
  let file = "";
  let lineNum = 1;
  const messages: string[] = [];

  for (const out of outputLines) {
    const match = FILE_LINE_RE.exec(out);
    if (match && !file) {
      file = path.relative(cwd, path.resolve(cwd, match[1]!));
      lineNum = parseInt(match[2]!, 10);
      if (match[3]) messages.push(match[3]);
    } else if (out.trim() && !out.startsWith("=== RUN") && !out.startsWith("--- FAIL")) {
      messages.push(out.trim());
    }
  }

  return {
    file,
    lineNum,
    message: messages.join("\n").slice(0, 2000),
  };
}
