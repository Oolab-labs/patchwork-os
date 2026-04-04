import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createGetDocumentSymbolsTool } from "../getDocumentSymbols.js";

// Mock execSafe so grep fallback tests don't require a real rg binary
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);

function makeRgResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
  };
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "symbols-test-"));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const p = path.join(workspace, name);
  fs.writeFileSync(p, content);
  return p;
}

function mockConnected(symbols: unknown, throwTimeout = false): any {
  return {
    isConnected: () => true,
    getDocumentSymbols: async () => {
      if (throwTimeout) throw new ExtensionTimeoutError("timeout");
      return symbols;
    },
  };
}

function mockDisconnected(): any {
  return { isConnected: () => false };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

// ── LSP extension path ─────────────────────────────────────────────────────────

describe("getDocumentSymbols: LSP extension path", () => {
  it("returns LSP symbols with source: lsp when extension is connected", async () => {
    const filePath = writeFile("lsp.ts", "export function foo() {}");
    const lspResult = {
      symbols: [{ name: "foo", kind: "Function", line: 1 }],
      count: 1,
    };
    const tool = createGetDocumentSymbolsTool(
      workspace,
      mockConnected(lspResult),
    );
    const result = await tool.handler({ filePath });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("lsp");
    expect(data.symbols).toHaveLength(1);
    expect(data.symbols[0].name).toBe("foo");
  });

  it("falls through to grep when extension returns null", async () => {
    const filePath = writeFile("fallthrough.ts", "export function bar() {}");
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:export function bar() {}\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockConnected(null));
    const result = await tool.handler({ filePath });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("grep-fallback");
  });

  it("falls through to grep when extension is disconnected", async () => {
    const filePath = writeFile("noext.ts", "const x = 1;");
    mockExecSafe.mockResolvedValue(makeRgResult(""));
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(["grep-fallback", "unavailable"]).toContain(data.source);
  });

  it("returns timeout error when extension times out (does not silently fall through)", async () => {
    const filePath = writeFile("timeout.ts", "export function baz() {}");
    const tool = createGetDocumentSymbolsTool(
      workspace,
      mockConnected(null, true),
    );
    const result = await tool.handler({ filePath });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });
});

// ── Grep fallback: unsupported language ───────────────────────────────────────

describe("getDocumentSymbols: unsupported language", () => {
  it("returns unavailable with note for unknown language (.rb)", async () => {
    const filePath = writeFile("script.rb", "def foo; end");
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.source).toBe("unavailable");
    expect(data.note).toMatch(/ruby|rb/i);
  });
});

// ── Grep fallback: file not found ─────────────────────────────────────────────

describe("getDocumentSymbols: file not found", () => {
  it("returns error when file does not exist", async () => {
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath: `${workspace}/missing.ts` });
    expect(result.isError).toBe(true);
  });
});

// ── Grep fallback: TypeScript ─────────────────────────────────────────────────

describe("getDocumentSymbols: TypeScript grep fallback", () => {
  it("finds exported function", async () => {
    const filePath = writeFile("ts1.ts", "export function hello() {}\n");
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:export function hello() {}\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    expect(data.source).toBe("grep-fallback");
    const sym = data.symbols.find((s: any) => s.name === "hello");
    expect(sym).toBeDefined();
    expect(sym.kind).toBe("Function");
  });

  it("finds class declaration", async () => {
    const filePath = writeFile("ts2.ts", "export class MyService {}\n");
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:export class MyService {}\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    const sym = data.symbols.find((s: any) => s.name === "MyService");
    expect(sym).toBeDefined();
    expect(sym.kind).toBe("Class");
  });

  it("finds const declaration", async () => {
    const filePath = writeFile("ts3.ts", "export const MY_CONST = 42;\n");
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:export const MY_CONST = 42;\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    const sym = data.symbols.find((s: any) => s.name === "MY_CONST");
    expect(sym).toBeDefined();
    expect(sym.kind).toBe("Constant");
  });

  it("returns empty symbols when rg finds no matches", async () => {
    const filePath = writeFile("ts4.ts", "// just a comment\n");
    mockExecSafe.mockResolvedValue(makeRgResult(""));
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    expect(data.symbols).toHaveLength(0);
    expect(data.count).toBe(0);
    expect(data.source).toBe("grep-fallback");
  });
});

// ── Grep fallback: Python ─────────────────────────────────────────────────────

describe("getDocumentSymbols: Python grep fallback", () => {
  it("finds def and class", async () => {
    const filePath = writeFile(
      "script.py",
      "def greet():\n    pass\n\nclass Animal:\n    pass\n",
    );
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:def greet():\n4:class Animal:\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    expect(data.source).toBe("grep-fallback");
    const names = data.symbols.map((s: any) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("Animal");
    const fn = data.symbols.find((s: any) => s.name === "greet");
    expect(fn.kind).toBe("Function");
    const cls = data.symbols.find((s: any) => s.name === "Animal");
    expect(cls.kind).toBe("Class");
  });
});

// ── Grep fallback: Go ─────────────────────────────────────────────────────────

describe("getDocumentSymbols: Go grep fallback", () => {
  it("finds type declarations (note: func keyword not in name-extraction regex)", async () => {
    const filePath = writeFile(
      "main.go",
      "func Handler() {}\ntype Server struct {}\n",
    );
    // rg matches both lines; name-extraction regex supports 'type' but not 'func'
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:func Handler() {}\n2:type Server struct {}\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    const names = data.symbols.map((s: any) => s.name);
    // 'type Server' is extracted; 'func Handler' is not (func not in extraction regex)
    expect(names).toContain("Server");
    expect(names).not.toContain("Handler");
  });
});

// ── Grep fallback: Rust ───────────────────────────────────────────────────────

describe("getDocumentSymbols: Rust grep fallback", () => {
  it("finds fn and pub struct", async () => {
    const filePath = writeFile(
      "lib.rs",
      "fn process() {}\npub struct Config {}\n",
    );
    mockExecSafe.mockResolvedValue(
      makeRgResult("1:fn process() {}\n2:pub struct Config {}\n"),
    );
    const tool = createGetDocumentSymbolsTool(workspace, mockDisconnected());
    const result = await tool.handler({ filePath });
    const data = parse(result);
    const names = data.symbols.map((s: any) => s.name);
    expect(names).toContain("process");
    expect(names).toContain("Config");
    const fn_ = data.symbols.find((s: any) => s.name === "process");
    expect(fn_.kind).toBe("Function");
    const st = data.symbols.find((s: any) => s.name === "Config");
    expect(st.kind).toBe("Struct");
  });
});
