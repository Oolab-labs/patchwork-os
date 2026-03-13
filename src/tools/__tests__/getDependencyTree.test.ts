import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    execSafe: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

import { existsSync } from "node:fs";
import { createGetDependencyTreeTool } from "../getDependencyTree.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const mockExistsSync = vi.mocked(existsSync);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WORKSPACE = "/tmp/test-ws";

describe("getDependencyTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns available:false when no manifest found", async () => {
    const tool = createGetDependencyTreeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.error).toContain("No supported package manifest");
  });

  it("returns npm dependency tree on success", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        name: "my-app",
        version: "1.0.0",
        dependencies: {
          lodash: { version: "4.17.21" },
        },
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createGetDependencyTreeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("npm");
    expect(result.tree.name).toBe("my-app");
    expect(result.count).toBeGreaterThan(0);
  });

  it("returns available:false when npm ls returns no output", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "ELOCKVERIFY",
      exitCode: 1,
      timedOut: false,
      durationMs: 50,
    });

    const tool = createGetDependencyTreeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("uses cargo when Cargo.toml found", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("Cargo.toml"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        packages: [
          {
            name: "mylib",
            version: "0.1.0",
            dependencies: [{ name: "serde", req: ">=1.0" }],
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 200,
    });

    const tool = createGetDependencyTreeTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("cargo");
    expect(result.tree.name).toBe("mylib");
  });

  it("respects explicit packageManager arg", async () => {
    mockExistsSync.mockReturnValue(false); // no manifest
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        packages: [{ name: "x", version: "1.0.0", dependencies: [] }],
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createGetDependencyTreeTool(WORKSPACE);
    const result = parse(await tool.handler({ packageManager: "cargo" }));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("cargo");
  });
});
