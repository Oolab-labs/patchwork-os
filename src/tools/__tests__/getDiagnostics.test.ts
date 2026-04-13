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

describe("getDiagnostics — extension path relatedInformation sanitization", () => {
  it("caps relatedInformation at 5 entries and truncates messages to 200 chars", async () => {
    const relatedInfo = Array.from({ length: 10 }, (_, i) => ({
      message: "x".repeat(300) + ` related ${i}`,
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
