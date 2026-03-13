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
import { execSafe } from "../utils.js";
import { createGetSecurityAdvisoriesTool } from "../getSecurityAdvisories.js";

const mockExecSafe = vi.mocked(execSafe);
const mockExistsSync = vi.mocked(existsSync);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WORKSPACE = "/tmp/test-ws";

const NPM_AUDIT_RESPONSE = {
  vulnerabilities: {
    lodash: {
      severity: "high",
      via: [{ title: "Prototype Pollution", url: "https://npmjs.com/advisories/1" }],
      fixAvailable: { name: "lodash", version: "4.17.21" },
    },
    moment: {
      severity: "moderate",
      via: [{ title: "ReDoS" }],
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: { high: 1, moderate: 1 } },
};

describe("getSecurityAdvisories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns available:false when no manifest found", async () => {
    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.error).toContain("No supported package manifest");
  });

  it("parses npm audit output correctly", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify(NPM_AUDIT_RESPONSE),
      stderr: "",
      exitCode: 1, // npm audit exits 1 when vulns found
      timedOut: false,
      durationMs: 300,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("npm");
    expect(result.totalVulnerabilities).toBe(2);
    expect(result.bySeverity.high).toBe(1);
    expect(result.bySeverity.moderate).toBe(1);
    expect(result.advisories[0].package).toBe("lodash");
  });

  it("filters by severity", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify(NPM_AUDIT_RESPONSE),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 300,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({ severity: "high" }));
    expect(result.totalVulnerabilities).toBe(1);
    expect(result.advisories[0].severity).toBe("high");
  });

  it("returns available:false when npm not found", async () => {
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

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
  });

  it("returns available:false when output is empty", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
  });
});
