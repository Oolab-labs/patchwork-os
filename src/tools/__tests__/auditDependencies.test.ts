import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

import { existsSync } from "node:fs";
import { createAuditDependenciesTool } from "../auditDependencies.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);
const mockExistsSync = vi.mocked(existsSync);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WORKSPACE = "/tmp/test-ws";

describe("auditDependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns available:false when no manifest found", async () => {
    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.error).toContain("No supported package manifest");
  });

  it("auto-detects npm from package.json", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        lodash: { current: "4.0.0", wanted: "4.17.21", latest: "4.17.21" },
      }),
      stderr: "",
      exitCode: 1, // npm outdated exits 1 when packages are outdated
      timedOut: false,
      durationMs: 200,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("npm");
    expect(result.total).toBe(1);
    expect(result.packages[0].name).toBe("lodash");
    expect(result.packages[0].current).toBe("4.0.0");
    expect(result.packages[0].latest).toBe("4.17.21");
  });

  it("auto-detects cargo from Cargo.toml", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("Cargo.toml"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr:
        "   Updating serde v1.0.100 -> v1.0.200\n   Updating tokio v1.0.0 -> v1.5.0",
      exitCode: 0,
      timedOut: false,
      durationMs: 500,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("cargo");
    expect(result.total).toBe(2);
    expect(result.packages[0].name).toBe("serde");
    expect(result.packages[0].current).toBe("1.0.100");
    expect(result.packages[0].latest).toBe("1.0.200");
  });

  it("auto-detects pip from requirements.txt", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("requirements.txt"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: "requests", version: "2.25.0", latest_version: "2.28.0" },
      ]),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 300,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("pip");
    expect(result.total).toBe(1);
    expect(result.packages[0].name).toBe("requests");
    expect(result.packages[0].current).toBe("2.25.0");
    expect(result.packages[0].latest).toBe("2.28.0");
  });

  it("returns empty packages when npm outdated returns nothing", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.total).toBe(0);
    expect(result.packages).toHaveLength(0);
  });

  it("caches results within TTL", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValue({
      stdout: JSON.stringify({
        react: { current: "17.0.0", wanted: "18.0.0", latest: "18.0.0" },
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    await tool.handler({});
    await tool.handler({});

    expect(mockExecSafe).toHaveBeenCalledTimes(1);
  });

  it("returns available:false when binary not found", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "ENOENT: npm not found",
      exitCode: 127,
      timedOut: false,
      durationMs: 10,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.error).toContain("npm not found");
  });

  it("auto-detects pnpm from pnpm-lock.yaml (prefers over package.json)", async () => {
    mockExistsSync.mockImplementation(
      (p) =>
        String(p).endsWith("pnpm-lock.yaml") ||
        String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        "fast-glob": {
          current: "3.2.0",
          wanted: "3.3.0",
          latest: "3.3.0",
        },
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 150,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("pnpm");
    expect(result.total).toBe(1);
    expect(result.packages[0].name).toBe("fast-glob");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("pnpm");
  });

  it("auto-detects yarn from yarn.lock (prefers over package.json)", async () => {
    mockExistsSync.mockImplementation(
      (p) =>
        String(p).endsWith("yarn.lock") || String(p).endsWith("package.json"),
    );
    // yarn outdated --json emits multiple JSON lines; the "table" event has the data
    const tableEvent = JSON.stringify({
      type: "table",
      data: {
        head: ["Package", "Current", "Wanted", "Latest", "Package Type", "URL"],
        body: [["lodash", "4.17.19", "4.17.21", "4.17.21", "dependencies", ""]],
      },
    });
    mockExecSafe.mockResolvedValueOnce({
      stdout: `{"type":"info","data":"Colours"}\n${tableEvent}\n`,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 300,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("yarn");
    expect(result.total).toBe(1);
    expect(result.packages[0].name).toBe("lodash");
    expect(result.packages[0].current).toBe("4.17.19");
    expect(result.packages[0].latest).toBe("4.17.21");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("yarn");
  });

  it("yarn: returns empty packages when no table event in output", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("yarn.lock"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: '{"type":"info","data":"Done"}\n',
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("yarn");
    expect(result.total).toBe(0);
  });

  it("'auto' and explicit manager name share a single cache entry (no duplicate audit run)", async () => {
    // Regression: cacheKey was `pm` (the raw "auto" string) instead of the
    // resolved manager name. Calling with "auto" then "npm" ran two subprocess audits.
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValue({
      stdout: JSON.stringify({
        lodash: { current: "4.0.0", wanted: "4.17.21", latest: "4.17.21" },
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    // First call with "auto" — runs the audit
    await tool.handler({ packageManager: "auto" });
    // Second call with explicit "npm" — should hit the same cache entry
    await tool.handler({ packageManager: "npm" });

    // Only one subprocess should have been spawned
    expect(mockExecSafe).toHaveBeenCalledTimes(1);
  });

  it("respects explicit packageManager override", async () => {
    // package.json exists but we explicitly ask for cargo
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createAuditDependenciesTool(WORKSPACE);
    const result = parse(await tool.handler({ packageManager: "cargo" }));
    expect(result.packageManager).toBe("cargo");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("cargo");
  });
});
