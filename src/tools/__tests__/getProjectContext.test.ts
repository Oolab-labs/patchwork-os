import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProbes } from "../../__tests__/helpers/fixtures.js";
import type { ExtensionClient } from "../../extensionClient.js";
import type { ProbeResults } from "../../probe.js";
import { createGetProjectContextTool } from "../getProjectContext.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeClient(overrides: Partial<ExtensionClient> = {}): ExtensionClient {
  return {
    isConnected: () => false,
    getDiagnostics: vi.fn().mockResolvedValue([]),
    getOpenFiles: vi.fn().mockResolvedValue([]),
    latestActiveFile: null,
    ...overrides,
  } as unknown as ExtensionClient;
}

const NO_PROBES: ProbeResults = makeProbes();

let tmpDir: string;
let cacheDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpc-test-"));
  cacheDir = path.join(tmpDir, "cache");
  process.env.CLAUDE_CONFIG_DIR = cacheDir;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createGetProjectContextTool", () => {
  it("returns required top-level fields on fresh call", async () => {
    const workspace = tmpDir;
    const tool = createGetProjectContextTool(
      workspace,
      makeClient(),
      NO_PROBES,
    );
    const result = parse(await tool.handler({}));

    expect(typeof result.workspace).toBe("string");
    expect(typeof result.generatedAt).toBe("string");
    expect(typeof result.fromCache).toBe("boolean");
    expect(typeof result.brief).toBe("object");
    expect(typeof result.hint).toBe("string");
  });

  it("brief contains all required sub-fields", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);
    const result = parse(await tool.handler({}));
    const { brief } = result;

    expect("activeFile" in brief).toBe(true);
    expect(Array.isArray(brief.recentErrors)).toBe(true);
    expect(Array.isArray(brief.recentCommits)).toBe(true);
    expect(Array.isArray(brief.topModules)).toBe(true);
    expect(Array.isArray(brief.openFiles)).toBe(true);
    expect(typeof brief.diagnosticSummary).toBe("string");
  });

  it("returns fromCache:false on first call", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);
    const result = parse(await tool.handler({}));
    expect(result.fromCache).toBe(false);
  });

  it("returns fromCache:true on second call within maxAgeMs", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);

    // First call — writes cache
    await tool.handler({});

    // Second call — should hit cache
    const result = parse(await tool.handler({}));
    expect(result.fromCache).toBe(true);
  });

  it("force:true bypasses cache and returns fromCache:false", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);

    // Populate cache
    await tool.handler({});

    // Force regeneration
    const result = parse(await tool.handler({ force: true }));
    expect(result.fromCache).toBe(false);
  });

  it("cache expires after maxAgeMs and regenerates", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);

    // First call
    await tool.handler({ maxAgeMs: 1_000 });

    // Advance past TTL
    vi.advanceTimersByTime(2_000);

    const result = parse(await tool.handler({ maxAgeMs: 1_000 }));
    expect(result.fromCache).toBe(false);
  });

  it("populates activeFile from extensionClient.latestActiveFile", async () => {
    const client = makeClient({
      isConnected: () => true,
      latestActiveFile: "/workspace/src/main.ts",
    });
    const tool = createGetProjectContextTool(tmpDir, client, NO_PROBES);
    const result = parse(await tool.handler({}));
    expect(result.brief.activeFile).toBe("/workspace/src/main.ts");
  });

  // Regression for the two-shape getDiagnostics bug: the no-file branch of the
  // extension handler now returns a FLAT Diagnostic[] (each entry has `file`).
  // getProjectContext does `Array.isArray(diagnosticsResult.value)` + reads
  // `d.file`/`d.severity`/`d.message`. With the old grouped wrapper this branch
  // never ran and the tool reported "No errors or warnings".
  it("counts errors/warnings from the flat getDiagnostics array", async () => {
    const client = makeClient({
      isConnected: () => true,
      getDiagnostics: vi.fn().mockResolvedValue([
        { file: "/ws/a.ts", severity: "error", message: "boom", line: 1 },
        { file: "/ws/a.ts", severity: "warning", message: "meh", line: 2 },
        { file: "/ws/b.ts", severity: "error", message: "kaboom", line: 3 },
      ]),
    });
    const tool = createGetProjectContextTool(tmpDir, client, NO_PROBES);
    const result = parse(await tool.handler({ force: true }));

    expect(result.brief.diagnosticSummary).toBe("2 error(s), 1 warning(s)");
    expect(result.brief.recentErrors).toHaveLength(3);
    expect(result.brief.recentErrors[0].file).toBe("/ws/a.ts");
  });

  it("includes suggestedPrompt string in output", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);
    const result = parse(await tool.handler({}));
    expect(typeof result.suggestedPrompt).toBe("string");
    expect(result.suggestedPrompt.length).toBeGreaterThan(0);
  });

  it("includes memoryGraphQueries array in fresh result", async () => {
    const tool = createGetProjectContextTool(tmpDir, makeClient(), NO_PROBES);
    const result = parse(await tool.handler({}));
    expect(Array.isArray(result.memoryGraphQueries)).toBe(true);
    expect(result.memoryGraphQueries.length).toBeGreaterThan(0);
    const q = result.memoryGraphQueries[0];
    expect(typeof q.tool).toBe("string");
    expect(typeof q.hint).toBe("string");
  });
});
