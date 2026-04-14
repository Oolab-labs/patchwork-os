import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const NO_PROBES: ProbeResults = {
  universalCtags: false,
  ripgrep: false,
  git: false,
  typescript: false,
  node: false,
  python: false,
  go: false,
  rust: false,
  java: false,
  ruby: false,
  php: false,
  csharp: false,
  typescriptLanguageServer: false,
};

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
    expect(typeof q.description).toBe("string");
  });
});
