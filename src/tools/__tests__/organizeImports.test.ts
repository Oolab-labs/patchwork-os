import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrganizeImportsTool } from "../organizeImports.js";

// Mock execSafe while keeping all other utils intact
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    execSafe: vi.fn(),
  };
});

import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);

function parse(result: {
  content: Array<{ type: string; text: string }>;
  isError?: true;
}) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

const successResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 10,
};

const failResult = {
  stdout: "",
  stderr: "not found",
  exitCode: 1,
  timedOut: false,
  durationMs: 10,
};

// Minimal ExtensionClient stub
function makeExtClient(connected: boolean) {
  return {
    isConnected: () => connected,
    organizeImports: vi.fn().mockResolvedValue({}),
  } as unknown as import("../../extensionClient.js").ExtensionClient;
}

let tmpDir: string;
let testFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-imports-test-"));
  testFile = path.join(tmpDir, "index.ts");
  fs.writeFileSync(testFile, 'import z from "z";\nimport a from "a";\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("organizeImports — extension disconnected", () => {
  it("uses biome when biome exits 0", async () => {
    mockExecSafe.mockResolvedValueOnce(successResult); // biome

    const tool = createOrganizeImportsTool(tmpDir, makeExtClient(false));
    const result = await tool.handler({ filePath: "index.ts" });

    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.organized).toBe(true);
    expect(data.source).toBe("biome");
    // biome was called first
    expect(mockExecSafe).toHaveBeenCalledTimes(1);
    expect(mockExecSafe.mock.calls[0]![1]).toContain("biome");
  });

  it("falls back to prettier when biome fails and prettier exits 0", async () => {
    mockExecSafe
      .mockResolvedValueOnce(failResult) // biome fails
      .mockResolvedValueOnce(successResult); // prettier succeeds

    const tool = createOrganizeImportsTool(tmpDir, makeExtClient(false));
    const result = await tool.handler({ filePath: "index.ts" });

    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.organized).toBe(true);
    expect(data.source).toBe("prettier");
    expect(mockExecSafe).toHaveBeenCalledTimes(2);
    expect(mockExecSafe.mock.calls[1]![1]).toContain("prettier");
  });

  it("returns isError when both biome and prettier fail", async () => {
    mockExecSafe
      .mockResolvedValueOnce(failResult) // biome fails
      .mockResolvedValueOnce(failResult); // prettier fails

    const tool = createOrganizeImportsTool(tmpDir, makeExtClient(false));
    const result = await tool.handler({ filePath: "index.ts" });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/biome\/prettier/);
  });
});

describe("organizeImports — extension connected", () => {
  it("delegates to extension and does not call execSafe", async () => {
    const extClient = makeExtClient(true);
    const tool = createOrganizeImportsTool(tmpDir, extClient);
    const result = await tool.handler({ filePath: "index.ts" });

    expect(result.isError).toBeUndefined();
    expect(parse(result).source).toBe("extension");
    expect(mockExecSafe).not.toHaveBeenCalled();
  });
});
