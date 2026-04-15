import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExplainDiagnosticTool } from "../explainDiagnostic.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeExtensionClient(
  opts: {
    connected?: boolean;
    diagnostics?: Map<string, unknown[]>;
    hoverResult?: unknown;
    definitionResult?: unknown;
    callHierarchyResult?: unknown;
  } = {},
) {
  return {
    isConnected: () => opts.connected ?? false,
    latestDiagnostics: opts.diagnostics ?? new Map(),
    getHover: async () => opts.hoverResult ?? null,
    goToDefinition: async () => opts.definitionResult ?? null,
    getCallHierarchy: async () => opts.callHierarchyResult ?? null,
  } as never;
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "explain-diag-test-"));
  fs.writeFileSync(
    path.join(workspace, "sample.ts"),
    Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  );
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("createExplainDiagnosticTool", () => {
  it("returns required output fields", async () => {
    const tool = createExplainDiagnosticTool(workspace, makeExtensionClient());
    const result = parse(
      await tool.handler({ filePath: "sample.ts", line: 5, character: 1 }),
    );
    expect(Array.isArray(result.codeContext)).toBe(true);
    expect(Array.isArray(result.callers)).toBe(true);
    expect(typeof result.explanation).toBe("string");
  });

  it("codeContext includes surrounding lines", async () => {
    const tool = createExplainDiagnosticTool(workspace, makeExtensionClient());
    const result = parse(
      await tool.handler({ filePath: "sample.ts", line: 15, character: 1 }),
    );
    expect(result.codeContext.length).toBeGreaterThan(0);
    // Should include a >>> marker for the requested line
    const markedLine = result.codeContext.find((l: string) =>
      l.startsWith(">>>"),
    );
    expect(markedLine).toBeTruthy();
  });

  it("includes diagnostic when extension has one near the line", async () => {
    const resolved = path.join(workspace, "sample.ts");
    const diags = new Map<string, unknown[]>();
    diags.set(resolved, [
      {
        file: resolved,
        line: 5,
        column: 1,
        severity: "error",
        message: "Something went wrong",
      },
    ]);
    const tool = createExplainDiagnosticTool(
      workspace,
      makeExtensionClient({ diagnostics: diags }),
    );
    const result = parse(
      await tool.handler({ filePath: "sample.ts", line: 5, character: 1 }),
    );
    expect(result.diagnostic).not.toBeNull();
    expect(result.diagnostic?.severity).toBe("error");
    expect(result.diagnostic?.message).toBe("Something went wrong");
  });

  it("diagnostic is null when none present near line", async () => {
    const tool = createExplainDiagnosticTool(workspace, makeExtensionClient());
    const result = parse(
      await tool.handler({ filePath: "sample.ts", line: 15, character: 1 }),
    );
    expect(result.diagnostic).toBeNull();
  });

  it("includes definition when extension returns one", async () => {
    const defResult = [{ file: "/workspace/def.ts", line: 10, column: 5 }];
    const tool = createExplainDiagnosticTool(
      workspace,
      makeExtensionClient({ connected: true, definitionResult: defResult }),
    );
    const result = parse(
      await tool.handler({ filePath: "sample.ts", line: 5, character: 1 }),
    );
    expect(result.definition).not.toBeNull();
    expect(result.definition?.line).toBe(10);
  });

  it("includes callers from call hierarchy", async () => {
    const hierResult = {
      items: [
        { name: "callerFn", file: "/workspace/caller.ts", line: 3, column: 1 },
      ],
    };
    const tool = createExplainDiagnosticTool(
      workspace,
      makeExtensionClient({
        connected: true,
        callHierarchyResult: hierResult,
      }),
    );
    const result = parse(
      await tool.handler({ filePath: "sample.ts", line: 5, character: 1 }),
    );
    expect(result.callers.length).toBe(1);
    expect(result.callers[0].name).toBe("callerFn");
  });

  it("errors on non-existent file for path validation", async () => {
    const tool = createExplainDiagnosticTool(workspace, makeExtensionClient());
    // Path traversal should fail
    const result = await tool.handler({
      filePath: "../../etc/passwd",
      line: 1,
      character: 1,
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
