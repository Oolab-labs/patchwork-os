/**
 * M16-M19: LSP tool extension paths return shapes that violate outputSchema.
 *
 * M16: goToDefinition extension returns raw array — missing `found` field.
 * M17: findReferences extension refs use {file,line} — schema expects {uri,range}.
 *      Also missing `found` field.
 * M18: getHover extension returns {contents: string[]} — schema declares scalar string.
 *      Also missing `found` field.
 * M19: getDiagnostics single-file path returns diags without `file` field.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGetDiagnosticsTool } from "../getDiagnostics.js";
import {
  createFindReferencesTool,
  createGetHoverTool,
  createGoToDefinitionTool,
} from "../lsp.js";

let WORKSPACE: string;

beforeAll(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-schema-test-"));
  fs.writeFileSync(path.join(WORKSPACE, "foo.ts"), "export const x = 1;\n");
});

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

// Extension shape for goToDefinition: array of {file,line,column,endLine,endColumn}
const EXT_DEFINITION_ARRAY = [
  { file: "/src/foo.ts", line: 3, column: 7, endLine: 3, endColumn: 12 },
];

// Extension shape for findReferences: {references: [{file,line,...}]}
const EXT_REFERENCES = {
  references: [
    { file: "/src/foo.ts", line: 3, column: 7, endLine: 3, endColumn: 12 },
    { file: "/src/bar.ts", line: 9, column: 2, endLine: 9, endColumn: 7 },
  ],
};

// Extension shape for getHover: {contents: string[], range: {...}}
const EXT_HOVER = {
  contents: ["```typescript\nconst x: number\n```", "The value x"],
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 14 },
};

function makeExtClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: () => true,
    lspReadyLanguages: new Set(["typescript"]),
    goToDefinition: async () => EXT_DEFINITION_ARRAY,
    findReferences: async () => EXT_REFERENCES,
    getHover: async () => EXT_HOVER,
    getDiagnostics: async () => null,
    ...overrides,
  } as any;
}

// ── M16: goToDefinition ───────────────────────────────────────────────────────

describe("goToDefinition extension path — outputSchema compliance (M16)", () => {
  it("returns found:true with uri and range when extension returns a location array", async () => {
    const tool = createGoToDefinitionTool(WORKSPACE, makeExtClient());
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 1,
      column: 1,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(true);
    expect(typeof parsed.uri).toBe("string");
    expect(parsed.range).toBeDefined();
    expect(typeof parsed.range.startLine).toBe("number");
  });

  it("returns found:false when extension returns empty array", async () => {
    const tool = createGoToDefinitionTool(
      WORKSPACE,
      makeExtClient({ goToDefinition: async () => [] }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 1,
      column: 1,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
  });
});

// ── M17: findReferences ───────────────────────────────────────────────────────

describe("findReferences extension path — outputSchema compliance (M17)", () => {
  it("returns found:true and normalises refs to {uri, range} shape", async () => {
    const tool = createFindReferencesTool(WORKSPACE, makeExtClient());
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 1,
      column: 1,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(true);
    expect(Array.isArray(parsed.references)).toBe(true);
    expect(parsed.references.length).toBeGreaterThan(0);
    const ref = parsed.references[0];
    expect(typeof ref.uri).toBe("string");
    expect(ref.range).toBeDefined();
    expect(typeof ref.range.startLine).toBe("number");
  });

  it("returns found:false when extension returns empty references", async () => {
    const tool = createFindReferencesTool(
      WORKSPACE,
      makeExtClient({ findReferences: async () => ({ references: [] }) }),
    );
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 1,
      column: 1,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
  });
});

// ── M18: getHover ─────────────────────────────────────────────────────────────

describe("getHover extension path — outputSchema compliance (M18)", () => {
  it("returns found:true with scalar string contents when extension returns array", async () => {
    const tool = createGetHoverTool(WORKSPACE, makeExtClient());
    const result = (await tool.handler({
      filePath: "foo.ts",
      line: 1,
      column: 1,
    })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(true);
    expect(typeof parsed.contents).toBe("string");
    expect(parsed.contents).toContain("const x");
  });
});

// ── M19: getDiagnostics ───────────────────────────────────────────────────────

describe("getDiagnostics single-file extension path — outputSchema compliance (M19)", () => {
  it("injects file field when extension omits it from single-file diagnostics", async () => {
    // Extension single-file path returns diags without `file` field.
    const diagsWithoutFile = [
      {
        message: "Type error",
        severity: "error",
        line: 1,
        column: 5,
        endLine: 1,
        endColumn: 10,
        source: "ts",
        code: 2345,
      },
    ];
    const extClient = {
      isConnected: () => true,
      getDiagnostics: async (uri: string | undefined) => {
        if (uri) return diagsWithoutFile;
        return null;
      },
    } as any;
    const tool = createGetDiagnosticsTool(WORKSPACE, undefined, extClient);
    const filePath = path.join(WORKSPACE, "foo.ts");
    const result = (await tool.handler({ uri: filePath })) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.diagnostics).toBeDefined();
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    const diag = parsed.diagnostics[0];
    expect(typeof diag.file).toBe("string");
    expect(diag.file.length).toBeGreaterThan(0);
  });
});
