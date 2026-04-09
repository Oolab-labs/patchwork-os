/**
 * Tests for the three new LSP navigation tools:
 *   findImplementations, goToTypeDefinition, goToDeclaration
 *
 * Covers:
 *   - disconnected extension → graceful isError response
 *   - extension returns null (no results) → found: false
 *   - extension returns results → found: true with correct shape
 *   - extension timeout → lspColdStartError text
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import {
  createFindImplementationsTool,
  createGoToDeclarationTool,
  createGoToTypeDefinitionTool,
} from "../lsp.js";

let WORKSPACE: string;

beforeAll(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-nav-test-"));
  fs.writeFileSync(path.join(WORKSPACE, "foo.ts"), "export interface Foo {}\n");
});

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

// Mock with lspReadyLanguages so lspWithRetry returns "timeout" immediately
// without waiting for retry delays.
function makeExtClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: () => true,
    lspReadyLanguages: new Set(["typescript"]),
    findImplementations: async () => null,
    goToTypeDefinition: async () => null,
    goToDeclaration: async () => null,
    ...overrides,
  } as any;
}

function makeDisconnectedClient() {
  return { isConnected: () => false } as any;
}

const SAMPLE_LOCATION_RESULT = {
  found: true,
  locations: [
    { file: "/src/foo.ts", line: 10, column: 3, endLine: 10, endColumn: 20 },
  ],
};

const SAMPLE_IMPL_RESULT = {
  found: true,
  implementations: [
    { file: "/src/bar.ts", line: 5, column: 1, endLine: 5, endColumn: 30 },
  ],
  count: 1,
};

// ── findImplementations ───────────────────────────────────────────────────────

describe("findImplementations", () => {
  it("returns isError when extension is not connected", async () => {
    const tool = createFindImplementationsTool(
      WORKSPACE,
      makeDisconnectedClient(),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("extension");
  });

  it("returns found:false when extension returns null", async () => {
    const tool = createFindImplementationsTool(
      WORKSPACE,
      makeExtClient({ findImplementations: async () => null }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
    expect(parsed.implementations).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  it("returns implementations array when results exist", async () => {
    const tool = createFindImplementationsTool(
      WORKSPACE,
      makeExtClient({
        findImplementations: async () => SAMPLE_IMPL_RESULT,
      }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(true);
    expect(parsed.implementations).toHaveLength(1);
    expect(parsed.count).toBe(1);
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createFindImplementationsTool(
      WORKSPACE,
      makeExtClient({
        findImplementations: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/language server|cold/i);
  });
});

// ── goToTypeDefinition ────────────────────────────────────────────────────────

describe("goToTypeDefinition", () => {
  it("returns isError when extension is not connected", async () => {
    const tool = createGoToTypeDefinitionTool(
      WORKSPACE,
      makeDisconnectedClient(),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("extension");
  });

  it("returns found:false with message when extension returns null", async () => {
    const tool = createGoToTypeDefinitionTool(
      WORKSPACE,
      makeExtClient({ goToTypeDefinition: async () => null }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
    expect(parsed.message).toMatch(/type definition/i);
  });

  it("returns location when result exists", async () => {
    const tool = createGoToTypeDefinitionTool(
      WORKSPACE,
      makeExtClient({
        goToTypeDefinition: async () => SAMPLE_LOCATION_RESULT,
      }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(true);
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0].file).toBe("/src/foo.ts");
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createGoToTypeDefinitionTool(
      WORKSPACE,
      makeExtClient({
        goToTypeDefinition: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/language server|cold/i);
  });
});

// ── goToDeclaration ───────────────────────────────────────────────────────────

describe("goToDeclaration", () => {
  it("returns isError when extension is not connected", async () => {
    const tool = createGoToDeclarationTool(WORKSPACE, makeDisconnectedClient());
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("extension");
  });

  it("returns found:false with message when extension returns null", async () => {
    const tool = createGoToDeclarationTool(
      WORKSPACE,
      makeExtClient({ goToDeclaration: async () => null }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
    expect(parsed.message).toMatch(/declaration/i);
  });

  it("returns location when result exists", async () => {
    const tool = createGoToDeclarationTool(
      WORKSPACE,
      makeExtClient({
        goToDeclaration: async () => SAMPLE_LOCATION_RESULT,
      }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(true);
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0].file).toBe("/src/foo.ts");
  });

  it("returns cold-start error on timeout", async () => {
    const tool = createGoToDeclarationTool(
      WORKSPACE,
      makeExtClient({
        goToDeclaration: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 5,
      column: 3,
    })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/language server|cold/i);
  });
});
