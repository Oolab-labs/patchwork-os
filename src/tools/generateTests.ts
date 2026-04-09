import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import {
  error,
  optionalString,
  requireString,
  successStructured,
} from "./utils.js";

function extractTsJsExports(content: string): string[] {
  const exports: string[] = [];
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+const\s+(\w+)\s*=/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1] && !exports.includes(m[1])) exports.push(m[1]);
    }
  }
  if (/export\s+default/.test(content) && !exports.includes("default")) {
    exports.push("default");
  }
  return exports;
}

function extractPythonExports(content: string): string[] {
  const exports: string[] = [];
  const re = /^(?:def|class)\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] && !exports.includes(m[1])) exports.push(m[1]);
  }
  return exports;
}

function detectFramework(
  framework: string,
  filePath: string,
  workspace: string,
): string {
  if (framework !== "auto") return framework;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py") return "pytest";
  if (
    existsSync(path.join(workspace, "vitest.config.ts")) ||
    existsSync(path.join(workspace, "vitest.config.js"))
  ) {
    return "vitest";
  }
  if (
    existsSync(path.join(workspace, "jest.config.js")) ||
    existsSync(path.join(workspace, "jest.config.ts"))
  ) {
    return "jest";
  }
  // Check package.json for jest
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(workspace, "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    if (
      pkg.jest !== undefined ||
      (pkg.devDependencies as Record<string, unknown>)?.jest
    ) {
      return "jest";
    }
  } catch {
    // ignore
  }
  return "vitest";
}

function deriveOutputFile(filePath: string, framework: string): string {
  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);
  const dir = path.dirname(filePath);

  if (framework === "pytest") {
    return path.join(dir, `test_${basename}.py`);
  }

  // TS/JS: replace first src/ with src/__tests__/
  const srcIndex = filePath.indexOf(`${path.sep}src${path.sep}`);
  if (srcIndex !== -1) {
    const beforeSrc = filePath.slice(0, srcIndex);
    const afterSrc = filePath.slice(srcIndex + 1 + "src".length + 1); // skip /src/
    return path.join(
      beforeSrc,
      "src",
      "__tests__",
      afterSrc.replace(ext, ".test.ts"),
    );
  }

  return filePath.replace(ext, ".test.ts");
}

function generateVitestScaffold(
  filePath: string,
  exports: string[],
  isJest: boolean,
): string {
  const relImport = `./${path.basename(filePath, path.extname(filePath))}.js`;
  const namedExports = exports.filter((e) => e !== "default");
  const hasDefault = exports.includes("default");

  const importParts: string[] = [];
  if (namedExports.length > 0)
    importParts.push(`{ ${namedExports.join(", ")} }`);
  if (hasDefault) importParts.push("defaultExport");

  const importLine =
    importParts.length > 0
      ? `import ${importParts.join(", ")} from "${relImport}";`
      : `// No named exports detected — update import as needed\nimport * as mod from "${relImport}";`;

  const frameworkImport = isJest
    ? `import { describe, it, expect, jest } from "@jest/globals";`
    : `import { describe, it, expect, vi } from "vitest";`;

  const blocks = exports.map((name) => {
    const testName = name === "default" ? "defaultExport" : name;
    return `  describe("${testName}", () => {\n    it("should work correctly", () => {\n      expect(${testName}).toBeDefined();\n    });\n  });`;
  });

  const moduleName = path.basename(filePath, path.extname(filePath));
  return [
    frameworkImport,
    importLine,
    "",
    `describe("${moduleName}", () => {`,
    blocks.join("\n\n"),
    "});",
    "",
  ].join("\n");
}

function generatePytestScaffold(filePath: string, exports: string[]): string {
  const moduleName = path.basename(filePath, ".py");
  const importLine =
    exports.length > 0
      ? `from ${moduleName} import ${exports.join(", ")}`
      : `import ${moduleName}`;

  const testFns = exports.map((name) => {
    return `def test_${name}():\n    pass`;
  });

  return ["import pytest", importLine, "", "", testFns.join("\n\n"), ""].join(
    "\n",
  );
}

export function createGenerateTestsTool(workspace: string) {
  return {
    schema: {
      name: "generateTests",
      description:
        "Generate a test file scaffold for a source file by extracting its exported functions and classes. " +
        "Returns ready-to-edit test content with describe/it blocks — does not write the file.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          file: {
            type: "string",
            description: "Path to the source file",
          },
          framework: {
            type: "string",
            enum: ["vitest", "jest", "pytest", "auto"],
            description: "Test framework (default: auto-detect)",
          },
          outputFile: {
            type: "string",
            description: "Suggested output path (default: auto-derived)",
          },
        },
        required: ["file"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Absolute path to source file" },
          outputFile: {
            type: "string",
            description: "Suggested output path for the test file",
          },
          framework: {
            type: "string",
            description: "Detected test framework (vitest, jest, pytest)",
          },
          exports: {
            type: "array",
            items: { type: "string" },
            description: "Exported names extracted from the source file",
          },
          content: {
            type: "string",
            description: "Generated test scaffold ready to write to outputFile",
          },
          exportCount: {
            type: "integer",
            description: "Number of exports detected",
          },
        },
        required: [
          "file",
          "outputFile",
          "framework",
          "exports",
          "content",
          "exportCount",
        ],
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      const fileArg = requireString(args, "file");
      const frameworkArg = optionalString(args, "framework") ?? "auto";
      const outputFileArg = optionalString(args, "outputFile");

      const filePath = path.isAbsolute(fileArg)
        ? fileArg
        : path.resolve(workspace, fileArg);

      let content: string;
      try {
        content = await fsPromises.readFile(filePath, "utf-8");
      } catch {
        return error(`Cannot read file: ${filePath}`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const isPython = ext === ".py";

      const exports = isPython
        ? extractPythonExports(content)
        : extractTsJsExports(content);

      const framework = detectFramework(frameworkArg, filePath, workspace);

      const outputFile = outputFileArg ?? deriveOutputFile(filePath, framework);

      let scaffold: string;
      if (framework === "pytest") {
        scaffold = generatePytestScaffold(filePath, exports);
      } else {
        scaffold = generateVitestScaffold(
          filePath,
          exports,
          framework === "jest",
        );
      }

      return successStructured({
        file: filePath,
        outputFile,
        framework,
        exports,
        content: scaffold,
        exportCount: exports.length,
      });
    },
  };
}
