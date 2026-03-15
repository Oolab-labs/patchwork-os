import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("ENOENT");
    }),
    promises: { ...actual.promises, readFile: vi.fn() },
  };
});

import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import { createGenerateTestsTool } from "../generateTests.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(fsPromises.readFile);

const WORKSPACE = "/tmp/test-workspace";

function makeHandler() {
  return createGenerateTestsTool(WORKSPACE).handler;
}

function parse(result: unknown) {
  return JSON.parse(
    (result as { content: Array<{ text: string }> }).content[0]!.text,
  );
}

describe("generateTests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  describe("error handling", () => {
    it("returns error for unreadable file", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));
      const result = await makeHandler()({ file: "/nonexistent/foo.ts" });
      expect((result as { isError: true }).isError).toBe(true);
      const text =
        (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(text).toContain("Cannot read file");
    });
  });

  describe("TS export extraction", () => {
    it("extracts exported functions", async () => {
      const src = `
export function foo() {}
export async function bar() {}
function notExported() {}
`;
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/utils.ts"),
        }),
      );
      expect(data.exports).toContain("foo");
      expect(data.exports).toContain("bar");
      expect(data.exports).not.toContain("notExported");
    });

    it("extracts exported classes", async () => {
      const src = `
export class MyClass {
  method() {}
}
class NotExported {}
`;
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/myClass.ts"),
        }),
      );
      expect(data.exports).toContain("MyClass");
      expect(data.exports).not.toContain("NotExported");
    });

    it("extracts export const", async () => {
      const src =
        "export const MY_CONST = 42;\nexport const helper = () => {};";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/consts.ts"),
        }),
      );
      expect(data.exports).toContain("MY_CONST");
      expect(data.exports).toContain("helper");
    });

    it("detects export default", async () => {
      const src = "export default function main() {}";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      const data = parse(
        await makeHandler()({ file: path.join(WORKSPACE, "src/main.ts") }),
      );
      expect(data.exports).toContain("default");
    });
  });

  describe("vitest scaffold generation", () => {
    it("generates correct vitest scaffold with import statement", async () => {
      const src =
        "export function add(a: number, b: number): number { return a + b; }";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      mockExistsSync.mockImplementation(
        (p) => typeof p === "string" && p.endsWith("vitest.config.ts"),
      );

      const data = parse(
        await makeHandler()({ file: path.join(WORKSPACE, "src/math.ts") }),
      );
      expect(data.framework).toBe("vitest");
      expect(data.content).toContain(
        `import { describe, it, expect, vi } from "vitest";`,
      );
      expect(data.content).toContain("import { add }");
      expect(data.content).toContain(`describe("add"`);
    });

    it("generates jest scaffold when framework=jest", async () => {
      const src = "export function add() {}";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);

      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/math.ts"),
          framework: "jest",
        }),
      );
      expect(data.framework).toBe("jest");
      expect(data.content).toContain(
        `import { describe, it, expect, jest } from "@jest/globals";`,
      );
    });
  });

  describe("pytest scaffold generation", () => {
    it("generates correct pytest scaffold for .py files", async () => {
      const src = `
def calculate(x, y):
    return x + y

class MyService:
    pass
`;
      mockReadFile.mockResolvedValue(src as unknown as Buffer);

      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/service.py"),
        }),
      );
      expect(data.framework).toBe("pytest");
      expect(data.exports).toContain("calculate");
      expect(data.exports).toContain("MyService");
      expect(data.content).toContain("import pytest");
      expect(data.content).toContain("from service import");
      expect(data.content).toContain("def test_calculate()");
      expect(data.content).toContain("def test_MyService()");
    });
  });

  describe("auto-detection", () => {
    it("auto-detects vitest from vitest.config.ts presence", async () => {
      const src = "export function x() {}";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      mockExistsSync.mockImplementation(
        (p) => typeof p === "string" && p.endsWith("vitest.config.ts"),
      );

      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/x.ts"),
          framework: "auto",
        }),
      );
      expect(data.framework).toBe("vitest");
    });

    it("auto-detects pytest for .py files", async () => {
      const src = "def foo(): pass";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);

      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/foo.py"),
          framework: "auto",
        }),
      );
      expect(data.framework).toBe("pytest");
    });
  });

  describe("output file derivation", () => {
    it("derives output file path (src/ → src/__tests__/)", async () => {
      const src = "export function foo() {}";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      mockExistsSync.mockImplementation(
        (p) => typeof p === "string" && p.endsWith("vitest.config.ts"),
      );

      const filePath = path.join(WORKSPACE, "src", "utils.ts");
      const data = parse(await makeHandler()({ file: filePath }));
      expect(data.outputFile).toContain(
        path.join("src", "__tests__", "utils.test.ts"),
      );
    });

    it("uses provided outputFile", async () => {
      const src = "export function foo() {}";
      mockReadFile.mockResolvedValue(src as unknown as Buffer);
      const customOutput = path.join(WORKSPACE, "tests", "foo.test.ts");

      const data = parse(
        await makeHandler()({
          file: path.join(WORKSPACE, "src/foo.ts"),
          outputFile: customOutput,
        }),
      );
      expect(data.outputFile).toBe(customOutput);
    });
  });
});
