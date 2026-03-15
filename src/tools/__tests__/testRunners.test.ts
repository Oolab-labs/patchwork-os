import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(
        () => '{"devDependencies":{"vitest":"^1.0.0","jest":"^29.0.0"}}',
      ),
      statSync: vi.fn(() => ({ isDirectory: () => true })),
      readdirSync: vi.fn(() => ["test_example.py"]),
    },
  };
});

import fs from "node:fs";
import { cargoTestRunner } from "../testRunners/cargoTest.js";
import { goTestRunner } from "../testRunners/goTest.js";
import { pytestRunner } from "../testRunners/pytest.js";
import { jestRunner, vitestRunner } from "../testRunners/vitestJest.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

const ok = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
  exitCode: 0,
  timedOut: false,
  durationMs: 50,
});

const probes = {
  biome: false,
  eslint: false,
  tsc: false,
  cargo: true,
  go: true,
  pyright: false,
  ruff: false,
  node: true,
  npm: true,
  npx: true,
  git: true,
  gh: false,
  python: true,
  codex: false,
  vitest: true,
  jest: true,
  pytest: true,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(
    '{"devDependencies":{"vitest":"^1.0.0","jest":"^29.0.0"}}' as any,
  );
});

// ── vitestRunner ──────────────────────────────────────────────────────────────

describe("vitestRunner", () => {
  it("detect() returns true when vitest devDep present", () => {
    expect(vitestRunner.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when no vitest devDep and no probe", () => {
    mockReadFileSync.mockReturnValue('{"devDependencies":{}}' as any);
    expect(vitestRunner.detect("/ws", { ...probes, vitest: false })).toBe(
      false,
    );
  });

  it("run() parses vitest JSON reporter output", async () => {
    const report = {
      testResults: [
        {
          testFilePath: "/ws/src/__tests__/foo.test.ts",
          testResults: [
            {
              fullName: "foo passes",
              status: "passed",
              duration: 10,
              failureMessages: [],
              location: { line: 5, column: 1 },
            },
            {
              fullName: "foo fails",
              status: "failed",
              duration: 5,
              failureMessages: ["Expected 1 to be 2\n  at foo.test.ts:10:3"],
              location: { line: 1, column: 1 },
            },
          ],
        },
      ],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(report)));
    const results = await vitestRunner.run("/ws");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      name: "foo passes",
      status: "passed",
      source: "vitest",
    });
    expect(results[1]).toMatchObject({ name: "foo fails", status: "failed" });
    expect(results[1].message).toContain("Expected 1 to be 2");
  });

  it("run() passes filter arg", async () => {
    mockExecSafe.mockResolvedValue(ok("{}"));
    await vitestRunner.run("/ws", "myFilter");
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("myFilter");
  });

  it("run() returns [] on empty stdout", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await vitestRunner.run("/ws")).toEqual([]);
  });

  it("run() handles skipped tests", async () => {
    const report = {
      testResults: [
        {
          testFilePath: "/ws/a.test.ts",
          testResults: [
            {
              fullName: "skipped",
              status: "pending",
              duration: 0,
              failureMessages: [],
            },
          ],
        },
      ],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(report)));
    const results = await vitestRunner.run("/ws");
    expect(results[0]?.status).toBe("skipped");
  });

  it("run() extracts line from stack trace when location is default", async () => {
    const report = {
      testResults: [
        {
          testFilePath: "/ws/a.test.ts",
          testResults: [
            {
              fullName: "failing",
              status: "failed",
              duration: 0,
              failureMessages: [
                "Error: fail\n  at Object.<anonymous> (/ws/a.test.ts:42:5)",
              ],
              location: { line: 1, column: 1 },
            },
          ],
        },
      ],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(report)));
    const results = await vitestRunner.run("/ws");
    expect(results[0]?.line).toBe(42);
  });
});

// ── jestRunner ────────────────────────────────────────────────────────────────

describe("jestRunner", () => {
  it("detect() returns true when jest devDep present", () => {
    expect(jestRunner.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when no jest devDep and no probe", () => {
    mockReadFileSync.mockReturnValue('{"devDependencies":{}}' as any);
    expect(jestRunner.detect("/ws", { ...probes, jest: false })).toBe(false);
  });

  it("run() parses jest --json output", async () => {
    const report = {
      testResults: [
        {
          testFilePath: "/ws/src/bar.test.ts",
          testResults: [
            {
              fullName: "bar works",
              status: "passed",
              duration: 8,
              failureMessages: [],
            },
          ],
        },
      ],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(report)));
    const results = await jestRunner.run("/ws");
    expect(results[0]).toMatchObject({
      name: "bar works",
      status: "passed",
      source: "jest",
    });
  });

  it("run() passes filter arg", async () => {
    mockExecSafe.mockResolvedValue(ok("{}"));
    await jestRunner.run("/ws", "myFilter");
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("myFilter");
  });

  it("run() returns [] when JSON not found in output", async () => {
    mockExecSafe.mockResolvedValue(ok("no json here"));
    expect(await jestRunner.run("/ws")).toEqual([]);
  });
});

// ── pytestRunner ──────────────────────────────────────────────────────────────

describe("pytestRunner", () => {
  it("detect() returns true when pytest probe + pytest.ini exist", () => {
    expect(pytestRunner.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when pytest probe missing", () => {
    expect(pytestRunner.detect("/ws", { ...probes, pytest: false })).toBe(
      false,
    );
  });

  it("detect() returns false when no config files or test dir", () => {
    mockExistsSync.mockReturnValue(false);
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(pytestRunner.detect("/ws", probes)).toBe(false);
  });

  it("run() parses FAILED lines from output", async () => {
    const output = [
      "FAILED tests/test_foo.py::TestFoo::test_bar - AssertionError: expected 1",
      "tests/test_foo.py:15: AssertionError",
      "1 failed, 2 passed",
    ].join("\n");
    mockExecSafe.mockResolvedValue(ok(output));
    const results = await pytestRunner.run("/ws");
    const failed = results.filter((r) => r.status === "failed");
    const passed = results.filter((r) => r.status === "passed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      name: "TestFoo::test_bar",
      status: "failed",
      source: "pytest",
    });
    expect(passed).toHaveLength(2);
  });

  it("run() returns [] when no failures and no summary", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await pytestRunner.run("/ws")).toEqual([]);
  });

  it("run() rejects filter starting with '-'", async () => {
    await expect(pytestRunner.run("/ws", "-k something")).rejects.toThrow(
      "must not start with",
    );
  });

  it("run() rejects filter with path traversal", async () => {
    await expect(pytestRunner.run("/ws", "../secret")).rejects.toThrow(
      "path traversal",
    );
  });
});

// ── cargoTestRunner ───────────────────────────────────────────────────────────

describe("cargoTestRunner", () => {
  it("detect() returns true when cargo probe + Cargo.toml exist", () => {
    expect(cargoTestRunner.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when cargo probe missing", () => {
    expect(cargoTestRunner.detect("/ws", { ...probes, cargo: false })).toBe(
      false,
    );
  });

  it("run() parses test ... ok / FAILED output", async () => {
    const output = [
      "test module::test_addition ... ok",
      "test module::test_subtract ... FAILED",
      "test module::test_skip ... ignored",
      "",
      "failures:",
      "thread 'module::test_subtract' panicked at 'assertion failed', src/lib.rs:42:5",
    ].join("\n");
    mockExecSafe.mockResolvedValue(ok(output));
    const results = await cargoTestRunner.run("/ws");
    const passed = results.filter((r) => r.status === "passed");
    const failed = results.filter((r) => r.status === "failed");
    const skipped = results.filter((r) => r.status === "skipped");
    expect(passed.length).toBeGreaterThanOrEqual(1);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]?.name).toBe("module::test_subtract");
  });

  it("run() returns [] on empty output", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await cargoTestRunner.run("/ws")).toEqual([]);
  });

  it("run() rejects filter starting with '-'", async () => {
    await expect(cargoTestRunner.run("/ws", "--flag")).rejects.toThrow(
      "must not start with",
    );
  });

  it("PANIC_NEW_RE does not incorrectly match old-style panic lines when message contains a colon+digit", async () => {
    // Old-style: panicked at 'expected 42:0 == 43:1', src/lib.rs:10:5
    // PANIC_RE fails to match because the message contains `'` (non-greedy stops early).
    // PANIC_NEW_RE must NOT mis-extract "'expected 42" as the file path.
    const output = [
      "test module::test_ratio ... FAILED",
      "",
      "failures:",
      "thread 'module::test_ratio' panicked at 'expected 42:0 == 43:1', src/lib.rs:10:5",
    ].join("\n");
    mockExecSafe.mockResolvedValue(ok(output));
    const results = await cargoTestRunner.run("/ws");
    const failed = results.filter((r) => r.status === "failed");
    expect(failed.length).toBe(1);
    // File path must not start with a quote character (would indicate PANIC_NEW_RE mis-matched)
    if (failed[0]?.file) {
      expect(failed[0].file).not.toMatch(/^'/);
    }
  });

  it("run() parses new-style panic format (Rust 1.73+)", async () => {
    const output = [
      "test module::test_new ... FAILED",
      "",
      "failures:",
      "thread 'module::test_new' panicked at src/lib.rs:15:3:",
      "explicit panic message here",
    ].join("\n");
    mockExecSafe.mockResolvedValue(ok(output));
    const results = await cargoTestRunner.run("/ws");
    const failed = results.filter((r) => r.status === "failed");
    expect(failed.length).toBe(1);
    expect(failed[0]?.line).toBe(15);
  });
});

// ── goTestRunner ──────────────────────────────────────────────────────────────

describe("goTestRunner", () => {
  it("detect() returns true when go probe + go.mod exist", () => {
    expect(goTestRunner.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when go probe missing", () => {
    expect(goTestRunner.detect("/ws", { ...probes, go: false })).toBe(false);
  });

  it("run() parses go test -json ndjson output", async () => {
    const events = [
      { Action: "run", Test: "TestAdd" },
      {
        Action: "output",
        Test: "TestAdd",
        Output: "--- PASS: TestAdd (0.00s)\n",
      },
      { Action: "pass", Test: "TestAdd", Elapsed: 0.001 },
      { Action: "run", Test: "TestSub" },
      {
        Action: "output",
        Test: "TestSub",
        Output: "--- FAIL: TestSub (0.00s)\n",
      },
      {
        Action: "output",
        Test: "TestSub",
        Output: "    sub_test.go:20: got 1 want 2\n",
      },
      { Action: "fail", Test: "TestSub", Elapsed: 0.002 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    mockExecSafe.mockResolvedValue(ok(events));
    const results = await goTestRunner.run("/ws");
    const passed = results.find((r) => r.name === "TestAdd");
    const failed = results.find((r) => r.name === "TestSub");
    expect(passed?.status).toBe("passed");
    expect(failed?.status).toBe("failed");
    expect(failed?.source).toBe("go-test");
  });

  it("run() returns [] on empty output", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await goTestRunner.run("/ws")).toEqual([]);
  });

  it("run() passes filter as -run arg", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    await goTestRunner.run("/ws", "TestFoo");
    const args = mockExecSafe.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-run");
    expect(args).toContain("TestFoo");
  });

  it("run() rejects filter starting with '-'", async () => {
    await expect(goTestRunner.run("/ws", "-bench=.")).rejects.toThrow(
      "must not start with",
    );
  });
});
