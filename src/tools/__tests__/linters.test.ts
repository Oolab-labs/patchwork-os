import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock execSafe while keeping other utils
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

// Mock fs so detect() results are controllable
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) } };
});

import { execSafe } from "../utils.js";
import fs from "node:fs";
import { biomeLinter } from "../linters/biome.js";
import { eslintLinter } from "../linters/eslint.js";
import { typescriptLinter } from "../linters/typescript.js";
import { cargoLinter } from "../linters/cargo.js";
import { govetLinter } from "../linters/govet.js";
import { pyrightLinter } from "../linters/pyright.js";
import { ruffLinter } from "../linters/ruff.js";

const mockExecSafe = vi.mocked(execSafe);
const mockExistsSync = vi.mocked(fs.existsSync);

const ok = (stdout: string, stderr = "") => ({
  stdout, stderr, exitCode: 0, timedOut: false, durationMs: 10,
});

const probes = {
  biome: true, eslint: true, tsc: true,
  cargo: true, go: true, pyright: true, ruff: true,
  node: true, npm: true, npx: true, git: true, gh: true,
  python: true, codex: false,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

// ── biome ─────────────────────────────────────────────────────────────────────

describe("biomeLinter", () => {
  it("detect() returns true when binary + config exist", () => {
    expect(biomeLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when biome probe missing", () => {
    expect(biomeLinter.detect("/ws", { ...probes, biome: false })).toBe(false);
  });

  it("detect() returns false when config file missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(biomeLinter.detect("/ws", probes)).toBe(false);
  });

  it("run() parses diagnostics from JSON output", async () => {
    const payload = {
      diagnostics: [
        { path: { file: "src/a.ts" }, severity: "error", description: "Unused variable", category: "lint/correctness/noUnusedVars" },
        { path: { file: "src/b.ts" }, severity: "warn", description: "Missing semicolon", category: "lint/style" },
      ],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(payload)));
    const result = await biomeLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "src/a.ts", severity: "error", message: "Unused variable", source: "biome" });
    expect(result[1]).toMatchObject({ severity: "warning" });
  });

  it("run() returns [] on empty output", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await biomeLinter.run("/ws")).toEqual([]);
  });

  it("run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("not-json"));
    await expect(biomeLinter.run("/ws")).rejects.toThrow("biome");
  });

  it("run() returns [] when diagnostics array is empty", async () => {
    mockExecSafe.mockResolvedValue(ok(JSON.stringify({ diagnostics: [] })));
    expect(await biomeLinter.run("/ws")).toEqual([]);
  });
});

// ── eslint ────────────────────────────────────────────────────────────────────

describe("eslintLinter", () => {
  it("detect() returns true when binary + config exist", () => {
    expect(eslintLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when eslint probe missing", () => {
    expect(eslintLinter.detect("/ws", { ...probes, eslint: false })).toBe(false);
  });

  it("detect() returns false when config file missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(eslintLinter.detect("/ws", probes)).toBe(false);
  });

  it("run() parses eslint JSON format", async () => {
    const payload = [
      {
        filePath: "/ws/src/index.ts",
        messages: [
          { line: 10, column: 5, severity: 2, message: "no-unused-vars", ruleId: "no-unused-vars" },
          { line: 20, column: 1, severity: 1, message: "prefer-const", ruleId: "prefer-const" },
        ],
      },
      { filePath: "/ws/src/clean.ts", messages: [] },
    ];
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(payload)));
    const result = await eslintLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "/ws/src/index.ts", line: 10, severity: "error", source: "eslint" });
    expect(result[1]).toMatchObject({ severity: "warning" });
  });

  it("run() returns [] on empty output", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await eslintLinter.run("/ws")).toEqual([]);
  });

  it("run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("{bad"));
    await expect(eslintLinter.run("/ws")).rejects.toThrow("eslint");
  });

  it("run() handles null ruleId", async () => {
    const payload = [{ filePath: "/ws/a.ts", messages: [{ line: 1, column: 1, severity: 2, message: "err", ruleId: null }] }];
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(payload)));
    const result = await eslintLinter.run("/ws");
    expect(result[0].code).toBeUndefined();
  });
});

// ── typescript ────────────────────────────────────────────────────────────────

describe("typescriptLinter", () => {
  it("detect() returns true when tsc probe + tsconfig exist", () => {
    expect(typescriptLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when tsc probe missing", () => {
    expect(typescriptLinter.detect("/ws", { ...probes, tsc: false })).toBe(false);
  });

  it("detect() returns false when tsconfig.json missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(typescriptLinter.detect("/ws", probes)).toBe(false);
  });

  it("run() parses tsc error output from stderr", async () => {
    const tscOutput = [
      "src/index.ts(10,5): error TS2304: Cannot find name 'foo'",
      "src/utils.ts(3,1): warning TS6133: 'x' is declared but never used",
    ].join("\n");
    mockExecSafe.mockResolvedValue(ok("", tscOutput));
    const result = await typescriptLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "src/index.ts", line: 10, column: 5, severity: "error", code: "TS2304", source: "typescript" });
    expect(result[1]).toMatchObject({ severity: "warning", code: "TS6133" });
  });

  it("run() falls back to stdout when stderr empty", async () => {
    const tscOutput = "src/a.ts(1,1): error TS1: msg";
    mockExecSafe.mockResolvedValue(ok(tscOutput, ""));
    const result = await typescriptLinter.run("/ws");
    expect(result).toHaveLength(1);
  });

  it("run() returns [] when no output", async () => {
    mockExecSafe.mockResolvedValue(ok("", ""));
    expect(await typescriptLinter.run("/ws")).toEqual([]);
  });

  it("run() returns [] when output has no tsc pattern", async () => {
    mockExecSafe.mockResolvedValue(ok("", "some random text"));
    expect(await typescriptLinter.run("/ws")).toEqual([]);
  });
});

// ── cargo ─────────────────────────────────────────────────────────────────────

describe("cargoLinter", () => {
  it("detect() returns true when cargo probe + Cargo.toml exist", () => {
    expect(cargoLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when cargo probe missing", () => {
    expect(cargoLinter.detect("/ws", { ...probes, cargo: false })).toBe(false);
  });

  it("detect() returns false when Cargo.toml missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(cargoLinter.detect("/ws", probes)).toBe(false);
  });

  it("run() parses compiler-message JSON lines", async () => {
    const lines = [
      JSON.stringify({ reason: "compiler-message", message: { level: "error", message: "unused variable", code: { code: "unused_variables" }, spans: [{ file_name: "src/main.rs", line_start: 5, column_start: 9 }] } }),
      JSON.stringify({ reason: "compiler-artifact" }),
      JSON.stringify({ reason: "compiler-message", message: { level: "warning", message: "dead code", code: null, spans: [{ file_name: "src/lib.rs", line_start: 12, column_start: 1 }] } }),
    ].join("\n");
    mockExecSafe.mockResolvedValue(ok(lines));
    const result = await cargoLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "src/main.rs", line: 5, severity: "error", source: "cargo" });
    expect(result[1]).toMatchObject({ severity: "warning" });
  });

  it("run() skips messages with no spans", async () => {
    const line = JSON.stringify({ reason: "compiler-message", message: { level: "error", message: "err", spans: [] } });
    mockExecSafe.mockResolvedValue(ok(line));
    expect(await cargoLinter.run("/ws")).toEqual([]);
  });

  it("run() ignores malformed JSON lines", async () => {
    mockExecSafe.mockResolvedValue(ok("bad-line\nnot-json\n\n"));
    expect(await cargoLinter.run("/ws")).toEqual([]);
  });
});

// ── govet ─────────────────────────────────────────────────────────────────────

describe("govetLinter", () => {
  it("detect() returns true when go probe + go.mod exist", () => {
    expect(govetLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when go probe missing", () => {
    expect(govetLinter.detect("/ws", { ...probes, go: false })).toBe(false);
  });

  it("detect() returns false when go.mod missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(govetLinter.detect("/ws", probes)).toBe(false);
  });

  it("run() parses go vet output from stderr", async () => {
    const output = [
      "pkg/handler.go:25:3: printf format %s has arg of wrong type",
      "cmd/main.go:10:1: unreachable code",
    ].join("\n");
    mockExecSafe.mockResolvedValue({ stdout: "", stderr: output, exitCode: 1, timedOut: false, durationMs: 10 });
    const result = await govetLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "pkg/handler.go", line: 25, column: 3, severity: "warning", source: "govet" });
    expect(result[1]).toMatchObject({ file: "cmd/main.go", line: 10 });
  });

  it("run() returns [] when no output", async () => {
    mockExecSafe.mockResolvedValue(ok("", ""));
    expect(await govetLinter.run("/ws")).toEqual([]);
  });

  it("run() returns [] when output has no matching pattern", async () => {
    mockExecSafe.mockResolvedValue(ok("", "ok pkg/..."));
    expect(await govetLinter.run("/ws")).toEqual([]);
  });
});

// ── pyright ───────────────────────────────────────────────────────────────────

describe("pyrightLinter", () => {
  it("detect() returns true when pyright probe available", () => {
    expect(pyrightLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when pyright probe missing", () => {
    expect(pyrightLinter.detect("/ws", { ...probes, pyright: false })).toBe(false);
  });

  it("run() parses pyright JSON output", async () => {
    const payload = {
      generalDiagnostics: [
        { file: "/ws/app.py", range: { start: { line: 4, character: 2 } }, severity: "error", message: "Type mismatch", rule: "reportGeneralTypeIssues" },
        { file: "/ws/utils.py", range: { start: { line: 0, character: 0 } }, severity: "warning", message: "Missing return" },
      ],
    };
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(payload)));
    const result = await pyrightLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "/ws/app.py", line: 5, column: 3, severity: "error", source: "pyright", code: "reportGeneralTypeIssues" });
    expect(result[1]).toMatchObject({ severity: "warning" });
  });

  it("run() returns [] on empty output", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await pyrightLinter.run("/ws")).toEqual([]);
  });

  it("run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("{bad}"));
    await expect(pyrightLinter.run("/ws")).rejects.toThrow("pyright");
  });
});

// ── ruff ──────────────────────────────────────────────────────────────────────

describe("ruffLinter", () => {
  it("detect() returns true when ruff probe available", () => {
    expect(ruffLinter.detect("/ws", probes)).toBe(true);
  });

  it("detect() returns false when ruff probe missing", () => {
    expect(ruffLinter.detect("/ws", { ...probes, ruff: false })).toBe(false);
  });

  it("run() parses ruff JSON output", async () => {
    const payload = [
      { filename: "/ws/app.py", location: { row: 3, column: 1 }, code: "E302", message: "Expected 2 blank lines" },
      { filename: "/ws/utils.py", location: { row: 10, column: 5 }, code: "F401", message: "Unused import" },
    ];
    mockExecSafe.mockResolvedValue(ok(JSON.stringify(payload)));
    const result = await ruffLinter.run("/ws");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ file: "/ws/app.py", line: 3, column: 1, severity: "warning", source: "ruff", code: "E302" });
    expect(result[1]).toMatchObject({ file: "/ws/utils.py", code: "F401" });
  });

  it("run() returns [] on empty output", async () => {
    mockExecSafe.mockResolvedValue(ok(""));
    expect(await ruffLinter.run("/ws")).toEqual([]);
  });

  it("run() returns [] on empty array", async () => {
    mockExecSafe.mockResolvedValue(ok("[]"));
    expect(await ruffLinter.run("/ws")).toEqual([]);
  });
});

// ── linter parse-error propagation ───────────────────────────────────────────
// These tests verify that linters throw (not silently return []) when the
// linter binary outputs unexpected non-JSON. This ensures getDiagnostics can
// surface linterErrors instead of reporting a false "no issues found".

describe("linter parse-error propagation", () => {
  it("biomeLinter.run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("error: biome crashed\nwith a stack trace"));
    await expect(biomeLinter.run("/ws")).rejects.toThrow();
  });

  it("eslintLinter.run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("ESLint: Failed to load config file"));
    await expect(eslintLinter.run("/ws")).rejects.toThrow();
  });

  it("pyrightLinter.run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("pyright: error loading config"));
    await expect(pyrightLinter.run("/ws")).rejects.toThrow();
  });

  it("ruffLinter.run() throws on malformed JSON output", async () => {
    mockExecSafe.mockResolvedValue(ok("ruff: unknown flag --output-format"));
    await expect(ruffLinter.run("/ws")).rejects.toThrow();
  });
});
