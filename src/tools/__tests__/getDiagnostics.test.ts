/**
 * Tests that getDiagnostics surfaces linter errors rather than silently
 * returning empty diagnostics when a linter's JSON parsing fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) } };
});

import { createGetDiagnosticsTool } from "../getDiagnostics.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);

const ok = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
  exitCode: 0,
  timedOut: false,
  durationMs: 10,
});

const probes = {
  biome: true,
  eslint: false,
  tsc: false,
  cargo: false,
  go: false,
  pyright: false,
  ruff: false,
  node: true,
  npm: true,
  npx: true,
  git: true,
  gh: false,
  python: false,
  codex: false,
} as any;

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

beforeEach(() => vi.clearAllMocks());

describe("getDiagnostics — linter error surfacing", () => {
  it("reports linterErrors when a linter outputs non-JSON", async () => {
    // Biome crashes and outputs plain text instead of JSON
    mockExecSafe.mockResolvedValue(ok("error: failed to load config"));
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    expect(data.available).toBe(true);
    // Should include linterErrors key with biome's error, not silently empty
    expect(data.linterErrors).toBeDefined();
    expect(data.linterErrors.biome).toBeDefined();
  });

  it("includes empty linterErrors when linters run cleanly", async () => {
    mockExecSafe.mockResolvedValue(ok(JSON.stringify({ diagnostics: [] })));
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    expect(data.linterErrors).toEqual({});
  });
});

describe("getDiagnostics — aborted-caller dedup", () => {
  it("returns empty diagnostics immediately when caller signal is pre-aborted (no new linter run)", async () => {
    // Regression: before fix, a pre-aborted signal with no in-flight run still
    // triggered a new execSafe subprocess that would be immediately killed.
    const controller = new AbortController();
    controller.abort();
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}, controller.signal));
    expect(data.available).toBe(true);
    expect(data.diagnostics).toHaveLength(0);
    // No linter subprocess should have been spawned
    expect(mockExecSafe).not.toHaveBeenCalled();
  });
});

describe("getDiagnostics — message sanitization", () => {
  it("strips control characters from diagnostic messages", async () => {
    // biome linter uses `description` field in its JSON output
    const malicious = "Real error\x00\x01\x1f injected text";
    mockExecSafe.mockResolvedValue(
      ok(
        JSON.stringify({
          diagnostics: [
            {
              path: { file: "/ws/foo.ts" },
              severity: "error",
              description: malicious,
              category: "lint",
            },
          ],
        }),
      ),
    );
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    const msg = data.diagnostics[0].message as string;
    expect(msg).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(msg).toContain("Real error");
  });

  it("truncates messages longer than 500 characters", async () => {
    const longMsg = "x".repeat(600);
    mockExecSafe.mockResolvedValue(
      ok(
        JSON.stringify({
          diagnostics: [
            {
              path: { file: "/ws/foo.ts" },
              severity: "error",
              description: longMsg,
              category: "lint",
            },
          ],
        }),
      ),
    );
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    expect((data.diagnostics[0].message as string).length).toBe(500);
  });
});

describe("getDiagnostics — topN param", () => {
  it("topN:2 with 5 diagnostics returns 2 and truncated:true", async () => {
    const diags = Array.from({ length: 5 }, (_, i) => ({
      file: `/ws/file${i}.ts`,
      line: i + 1,
      column: 1,
      severity: i < 2 ? "error" : "warning",
      message: `Diag ${i}`,
    }));
    const mockClient = {
      isConnected: () => true,
      getDiagnostics: vi.fn(async () => diags),
    };
    const tool = createGetDiagnosticsTool("/ws", probes, mockClient as never);
    const data = parse(await tool.handler({ topN: 2 }));
    expect(data.diagnostics).toHaveLength(2);
    expect(data.truncated).toBe(true);
  });

  it("topN larger than result count — no truncation", async () => {
    const diags = [
      {
        file: "/ws/a.ts",
        line: 1,
        column: 1,
        severity: "error",
        message: "E1",
      },
      {
        file: "/ws/b.ts",
        line: 2,
        column: 1,
        severity: "warning",
        message: "W1",
      },
    ];
    const mockClient = {
      isConnected: () => true,
      getDiagnostics: vi.fn(async () => diags),
    };
    const tool = createGetDiagnosticsTool("/ws", probes, mockClient as never);
    const data = parse(await tool.handler({ topN: 10 }));
    expect(data.diagnostics).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
  });
});

describe("getDiagnostics — extension path relatedInformation sanitization", () => {
  it("caps relatedInformation at 5 entries and truncates messages to 200 chars", async () => {
    const relatedInfo = Array.from({ length: 10 }, (_, i) => ({
      message: `${"x".repeat(300)} related ${i}`,
      file: "/ws/bar.ts",
      line: i,
      column: 0,
    }));
    const mockClient = {
      isConnected: () => true,
      getDiagnostics: vi.fn(async () => [
        {
          file: "/ws/foo.ts",
          line: 1,
          column: 1,
          severity: "error",
          message: "Type mismatch",
          relatedInformation: relatedInfo,
        },
      ]),
    };
    const tool = createGetDiagnosticsTool("/ws", probes, mockClient as never);
    const data = parse(await tool.handler({ uri: "/ws/foo.ts" }));
    const diag = data.diagnostics[0];
    expect(diag.relatedInformation).toHaveLength(5);
    expect(
      (diag.relatedInformation[0].message as string).length,
    ).toBeLessThanOrEqual(200);
  });
});

describe("getDiagnostics — trailing-period dedup normalization", () => {
  // Biome JSON format: { diagnostics: [{ path: { file }, description, severity, category }] }
  // The biome linter maps `description` → `message` and always sets line=1, column=1.
  // So two diagnostics with same file + same message (differing only by period) on the
  // same position will collide in the dedup key.
  it("deduplicates two diagnostics differing only by trailing period", async () => {
    // tsc emits "Cannot find name 'x'." (with period)
    // extension / pyright may emit "Cannot find name 'x'" (without)
    const biomeOutput = JSON.stringify({
      diagnostics: [
        {
          path: { file: "/ws/foo.ts" },
          description: "Cannot find name 'x'.",
          severity: "error",
          category: "parse",
        },
        {
          path: { file: "/ws/foo.ts" },
          description: "Cannot find name 'x'",
          severity: "error",
          category: "parse",
        },
      ],
    });
    mockExecSafe.mockResolvedValue(ok(biomeOutput));
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    // The two messages differ only by trailing period — should be deduped to 1
    expect(data.diagnostics.length).toBe(1);
  });

  it("does not dedup diagnostics that differ in message content", async () => {
    const biomeOutput = JSON.stringify({
      diagnostics: [
        {
          path: { file: "/ws/foo.ts" },
          description: "Type 'string' is not assignable to type 'number'.",
          severity: "error",
          category: "parse",
        },
        {
          path: { file: "/ws/foo.ts" },
          description: "Type 'boolean' is not assignable to type 'number'.",
          severity: "error",
          category: "parse",
        },
      ],
    });
    mockExecSafe.mockResolvedValue(ok(biomeOutput));
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    // Different messages — should NOT be deduped
    expect(data.diagnostics.length).toBe(2);
  });
});
