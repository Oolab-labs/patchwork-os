import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefactorExtractFunctionTool } from "../refactorExtractFunction.js";

let tmpDir: string;

function makeExtensionClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: vi.fn(() => true),
    getCodeActions: vi.fn().mockResolvedValue([]),
    applyCodeAction: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as import("../../extensionClient.js").ExtensionClient;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("refactorExtractFunction", () => {
  it("returns extensionRequired error when extension not connected", async () => {
    const client = makeExtensionClient({ isConnected: vi.fn(() => false) });
    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    const result = tool.handler({
      file: "foo.ts",
      startLine: 1,
      endLine: 3,
      functionName: "extracted",
    });
    const parsed = parse(await result);
    // extensionRequired returns isError
    expect(((await result) as { isError?: boolean }).isError).toBe(true);
    void parsed;
  });

  it("uses VS Code code action when Extract action is found", async () => {
    const file = path.join(tmpDir, "test.ts");
    fs.writeFileSync(file, "const x = 1;\nconst y = 2;\nconst z = x + y;\n");

    const client = makeExtensionClient({
      getCodeActions: vi
        .fn()
        .mockResolvedValue([{ title: "Extract to function", id: "action-1" }]),
      applyCodeAction: vi.fn().mockResolvedValue({ success: true }),
    });

    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    const result = parse(
      await tool.handler({
        file: "test.ts",
        startLine: 1,
        endLine: 2,
        functionName: "myFn",
      }),
    );

    expect(result.refactored).toBe(true);
    expect(result.method).toBe("codeAction");
    expect(result.message).toContain("Extract to function");
    expect(vi.mocked(client.applyCodeAction)).toHaveBeenCalledOnce();
  });

  it("falls back to text manipulation when no Extract action found", async () => {
    const file = path.join(tmpDir, "test.ts");
    fs.writeFileSync(file, "const x = 1;\nconst y = 2;\nconst z = 3;\n");

    const client = makeExtensionClient({
      getCodeActions: vi.fn().mockResolvedValue([]),
    });

    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    const result = parse(
      await tool.handler({
        file: "test.ts",
        startLine: 1,
        endLine: 2,
        functionName: "extracted",
      }),
    );

    expect(result.refactored).toBe(true);
    expect(result.method).toBe("textManipulation");
    // File should have been modified: new function inserted, extracted block replaced by call
    const newContent = fs.readFileSync(file, "utf-8");
    expect(newContent).toContain("function extracted");
    expect(newContent).toContain("extracted();");
    // The extracted lines should no longer appear as bare statements
    // (they are now inside the new function body)
    expect(newContent).not.toMatch(/^const x = 1;$/m);
    expect(newContent).not.toMatch(/^const y = 2;$/m);
    // The third line (not extracted) must be preserved
    expect(newContent).toContain("const z = 3;");
  });

  it("falls back to text manipulation when getCodeActions throws", async () => {
    const file = path.join(tmpDir, "test.ts");
    fs.writeFileSync(file, "const a = 1;\nconst b = 2;\n");

    const client = makeExtensionClient({
      getCodeActions: vi.fn().mockRejectedValue(new Error("extension error")),
    });

    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    const result = parse(
      await tool.handler({
        file: "test.ts",
        startLine: 1,
        endLine: 1,
        functionName: "doStuff",
      }),
    );

    expect(result.refactored).toBe(true);
    expect(result.method).toBe("textManipulation");
  });

  it("returns refactored:false for path outside workspace", async () => {
    const client = makeExtensionClient();
    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    const result = parse(
      await tool.handler({
        file: "../../etc/passwd",
        startLine: 1,
        endLine: 1,
        functionName: "fn",
      }),
    );
    expect(result.refactored).toBe(false);
    expect(result.message).toContain("escapes workspace");
  });

  it("rejects functionName with braces/parens (code injection chars)", async () => {
    const file = path.join(tmpDir, "inject.ts");
    fs.writeFileSync(file, "const x = 1;\n");
    const tool = createRefactorExtractFunctionTool(
      tmpDir,
      makeExtensionClient(),
    );
    const result = await tool.handler({
      file: "inject.ts",
      startLine: 1,
      endLine: 1,
      functionName: "x(){evil()};function legit",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("valid identifier");
  });

  it("rejects functionName exceeding 64 characters", async () => {
    const file = path.join(tmpDir, "longname.ts");
    fs.writeFileSync(file, "const x = 1;\n");
    const tool = createRefactorExtractFunctionTool(
      tmpDir,
      makeExtensionClient(),
    );
    const result = await tool.handler({
      file: "longname.ts",
      startLine: 1,
      endLine: 1,
      functionName: "a".repeat(65),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("valid identifier");
  });

  it("accepts valid camelCase identifier", async () => {
    const file = path.join(tmpDir, "valid.ts");
    fs.writeFileSync(file, "const x = 1;\n");
    const client = makeExtensionClient({
      getCodeActions: vi.fn().mockResolvedValue([]),
    });
    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    const result = await tool.handler({
      file: "valid.ts",
      startLine: 1,
      endLine: 1,
      functionName: "myValidFunction",
    });
    // Not a validation error
    expect(result.isError).toBeUndefined();
  });

  it("getCodeActions called with correct arguments", async () => {
    const file = path.join(tmpDir, "check.ts");
    fs.writeFileSync(file, "const x = 1;\n");

    const client = makeExtensionClient({
      getCodeActions: vi.fn().mockResolvedValue([]),
    });

    const tool = createRefactorExtractFunctionTool(tmpDir, client);
    await tool.handler({
      file: "check.ts",
      startLine: 3,
      endLine: 7,
      functionName: "fn",
    });

    const callArgs = vi.mocked(client.getCodeActions).mock.calls[0];
    expect(callArgs?.[1]).toBe(3); // startLine
    expect(callArgs?.[3]).toBe(7); // endLine
  });
});
