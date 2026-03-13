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

  it("does not include linterErrors when linters run cleanly", async () => {
    mockExecSafe.mockResolvedValue(ok(JSON.stringify({ diagnostics: [] })));
    const tool = createGetDiagnosticsTool("/ws", probes);
    const data = parse(await tool.handler({}));
    expect(data.linterErrors).toBeUndefined();
  });
});
