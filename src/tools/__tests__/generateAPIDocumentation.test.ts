import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGenerateAPIDocumentationTool } from "../generateAPIDocumentation.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-doc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const SAMPLE_TS = `
/** Adds two numbers together. */
export function add(a: number, b: number): number {
  return a + b;
}

export const VERSION: string = "1.0.0";

export interface Config {
  host: string;
  port: number;
}

export type Handler = (req: Request) => Response;

export class Server {
  constructor(private config: Config) {}
  public start(): void {}
  public stop(): void {}
}
`;

describe("generateAPIDocumentation", () => {
  it("extracts exported functions with JSDoc", async () => {
    const file = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(file, SAMPLE_TS);

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["sample.ts"] }));

    expect(result.totalSymbols).toBeGreaterThan(0);
    const doc = result.files[0];
    expect(doc.file).toBe("sample.ts");
    expect(doc.symbols).toBeGreaterThan(0);
    expect(doc.documentation).toContain("add");
  });

  it("includes JSDoc description in markdown", async () => {
    const file = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(file, SAMPLE_TS);

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["sample.ts"] }));
    expect(result.files[0].documentation).toContain(
      "Adds two numbers together",
    );
  });

  it("detects interfaces and types", async () => {
    const file = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(file, SAMPLE_TS);

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["sample.ts"] }));
    const doc = result.files[0].documentation as string;
    expect(doc).toContain("Config");
    expect(doc).toContain("Handler");
  });

  it("detects exported consts", async () => {
    const file = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(file, SAMPLE_TS);

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["sample.ts"] }));
    expect(result.files[0].documentation).toContain("VERSION");
  });

  it("detects class with members", async () => {
    const file = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(file, SAMPLE_TS);

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["sample.ts"] }));
    expect(result.files[0].documentation).toContain("Server");
  });

  it("returns JSON format when requested", async () => {
    const file = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(file, SAMPLE_TS);

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(
      await tool.handler({ files: ["sample.ts"], format: "json" }),
    );
    // JSON format — documentation field should be valid JSON
    const parsed = JSON.parse(result.files[0].documentation);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("handles missing file gracefully", async () => {
    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["nonexistent.ts"] }));
    expect(result.files[0].documentation).toContain("Error");
  });

  it("handles empty file", async () => {
    const file = path.join(tmpDir, "empty.ts");
    fs.writeFileSync(file, "");

    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["empty.ts"] }));
    expect(result.files[0].symbols).toBe(0);
  });

  it("rejects paths outside workspace", async () => {
    const tool = createGenerateAPIDocumentationTool(tmpDir);
    const result = parse(await tool.handler({ files: ["../../etc/passwd"] }));
    expect(result.files[0].documentation).toContain("Error");
  });
});
