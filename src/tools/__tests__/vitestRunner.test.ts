import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

// Test the JSON parsing logic by exercising vitestRunner.run via a fake execSafe
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { vitestRunner } from "../testRunners/vitestJest.js";
import { execSafe } from "../utils.js";

const workspace = "/workspace";

function makeVitestReport(overrides?: object) {
  return JSON.stringify({
    numTotalTests: 2,
    testResults: [
      {
        // vitest uses `name`, not `testFilePath`
        name: `${workspace}/src/foo.test.ts`,
        status: "passed",
        // vitest uses `assertionResults`, not `testResults`
        assertionResults: [
          { fullName: "passes correctly", status: "passed", duration: 10 },
          {
            fullName: "fails hard",
            status: "failed",
            duration: 5,
            failureMessages: ["Expected 1 to equal 2"],
          },
        ],
        ...overrides,
      },
    ],
  });
}

function makeJestReport() {
  return JSON.stringify({
    numTotalTests: 1,
    testResults: [
      {
        // Jest uses `testFilePath`
        testFilePath: `${workspace}/src/bar.test.ts`,
        status: "passed",
        // Jest uses `testResults` per file
        testResults: [
          { fullName: "jest test passes", status: "passed", duration: 8 },
        ],
      },
    ],
  });
}

describe("vitestRunner JSON parsing", () => {
  beforeEach(() => {
    vi.mocked(execSafe).mockReset();
  });

  it("parses vitest assertionResults and name fields", async () => {
    vi.mocked(execSafe).mockResolvedValue({
      exitCode: 0,
      stdout: makeVitestReport(),
      stderr: "",
    });

    const results = await vitestRunner.run(workspace);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      name: "passes correctly",
      status: "passed",
      file: "src/foo.test.ts",
    });
    expect(results[1]).toMatchObject({
      name: "fails hard",
      status: "failed",
      message: expect.stringContaining("Expected 1 to equal 2"),
    });
  });

  it("falls back to testResults and testFilePath (Jest-style output)", async () => {
    vi.mocked(execSafe).mockResolvedValue({
      exitCode: 0,
      stdout: makeJestReport(),
      stderr: "",
    });

    const results = await vitestRunner.run(workspace);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: "jest test passes",
      status: "passed",
      file: "src/bar.test.ts",
    });
  });

  it("returns empty array when output has no parseable JSON report", async () => {
    vi.mocked(execSafe).mockResolvedValue({
      exitCode: 0,
      stdout: "no json here",
      stderr: "",
    });

    const results = await vitestRunner.run(workspace);
    expect(results).toHaveLength(0);
  });
});
