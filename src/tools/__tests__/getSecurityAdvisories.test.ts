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
import { createGetSecurityAdvisoriesTool } from "../getSecurityAdvisories.js";
import { execSafe } from "../utils.js";

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
      via: [
        { title: "Prototype Pollution", url: "https://npmjs.com/advisories/1" },
      ],
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

  it("auto-detects pnpm from pnpm-lock.yaml (prefers over package.json)", async () => {
    mockExistsSync.mockImplementation(
      (p) =>
        String(p).endsWith("pnpm-lock.yaml") ||
        String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        vulnerabilities: {
          axios: {
            severity: "high",
            via: [{ title: "SSRF", url: "https://npmjs.com/advisories/123" }],
            fixAvailable: { name: "axios", version: "1.6.8" },
          },
        },
        metadata: { vulnerabilities: { high: 1 } },
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 200,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("pnpm");
    expect(result.totalVulnerabilities).toBe(1);
    expect(result.advisories[0].package).toBe("axios");
    expect(result.advisories[0].fix).toContain("axios@1.6.8");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("pnpm");
  });

  it("auto-detects yarn from yarn.lock and parses auditAdvisory JSONL", async () => {
    mockExistsSync.mockImplementation(
      (p) =>
        String(p).endsWith("yarn.lock") || String(p).endsWith("package.json"),
    );
    const advisoryEvent = JSON.stringify({
      type: "auditAdvisory",
      data: {
        advisory: {
          id: 1654,
          module_name: "lodash",
          severity: "high",
          title: "Prototype Pollution",
          url: "https://npmjs.com/advisories/1654",
          patched_versions: ">=4.17.21",
        },
      },
    });
    mockExecSafe.mockResolvedValueOnce({
      stdout: `{"type":"info","data":"Colours"}\n${advisoryEvent}\n{"type":"auditSummary","data":{"vulnerabilities":{"high":1}}}`,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 400,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("yarn");
    expect(result.totalVulnerabilities).toBe(1);
    expect(result.advisories[0].id).toBe("1654");
    expect(result.advisories[0].package).toBe("lodash");
    expect(result.advisories[0].severity).toBe("high");
    expect(result.advisories[0].fix).toContain(">=4.17.21");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("yarn");
  });

  it("yarn: returns zero advisories when no auditAdvisory events in output", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("yarn.lock"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: '{"type":"auditSummary","data":{"vulnerabilities":{}}}\n',
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("yarn");
    expect(result.totalVulnerabilities).toBe(0);
  });

  it("pnpm: returns available:false when binary not found", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("pnpm-lock.yaml"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "ENOENT: pnpm not found",
      exitCode: 127,
      timedOut: false,
      durationMs: 10,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.packageManager).toBe("pnpm");
    expect(result.error).toContain("pnpm not found");
  });

  // ── cargo audit ─────────────────────────────────────────────────────────────

  it("auto-detects cargo from Cargo.toml", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("Cargo.toml"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        vulnerabilities: {
          list: [
            {
              advisory: {
                id: "RUSTSEC-2021-0001",
                title: "Segfault in time crate",
                url: "https://rustsec.org/advisories/RUSTSEC-2021-0001",
              },
              package: { name: "time" },
              versions: { patched: ["^0.2.23"] },
            },
          ],
        },
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 500,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("cargo");
    expect(result.totalVulnerabilities).toBe(1);
    expect(result.advisories[0].id).toBe("RUSTSEC-2021-0001");
    expect(result.advisories[0].package).toBe("time");
    expect(result.advisories[0].severity).toBe("high");
    expect(result.advisories[0].fix).toContain("^0.2.23");
    expect(result.advisories[0].url).toContain("rustsec.org");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("cargo");
    expect(callArgs?.[1]).toContain("--json");
  });

  it("cargo: returns zero vulnerabilities when list is empty", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("Cargo.toml"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({ vulnerabilities: { list: [] } }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 300,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("cargo");
    expect(result.totalVulnerabilities).toBe(0);
  });

  it("cargo: returns available:false and install hint when binary not found", async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("Cargo.toml"));
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "ENOENT: cargo not found",
      exitCode: 127,
      timedOut: false,
      durationMs: 10,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.packageManager).toBe("cargo");
    expect(result.error).toContain("cargo-audit");
    expect(result.error).toContain("cargo install cargo-audit");
  });

  // ── pip-audit ────────────────────────────────────────────────────────────────

  it("auto-detects pip from requirements.txt", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("requirements.txt"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        dependencies: [
          {
            name: "requests",
            version: "2.25.0",
            vulns: [
              {
                id: "PYSEC-2023-74",
                description: "Requests forwards proxy-authorization headers",
                fix_versions: ["2.31.0"],
              },
            ],
          },
        ],
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 400,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("pip");
    expect(result.totalVulnerabilities).toBe(1);
    expect(result.advisories[0].id).toBe("PYSEC-2023-74");
    expect(result.advisories[0].package).toBe("requests");
    expect(result.advisories[0].severity).toBe("high");
    expect(result.advisories[0].fix).toContain("2.31.0");
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("pip-audit");
  });

  it("auto-detects pip from pyproject.toml when requirements.txt absent", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("pyproject.toml"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({ dependencies: [] }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 200,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.packageManager).toBe("pip");
    expect(result.totalVulnerabilities).toBe(0);
    const callArgs = mockExecSafe.mock.calls[0];
    expect(callArgs?.[0]).toBe("pip-audit");
  });

  it("pip: multiple vulns on a single package expand into separate advisories", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("requirements.txt"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: JSON.stringify({
        dependencies: [
          {
            name: "pillow",
            version: "9.0.0",
            vulns: [
              {
                id: "PYSEC-2023-1",
                description: "Uncontrolled resource consumption",
                fix_versions: ["9.3.0"],
              },
              {
                id: "PYSEC-2023-2",
                description: "Buffer overflow in TIFF decoder",
                fix_versions: ["9.3.0"],
              },
            ],
          },
        ],
      }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 300,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(true);
    expect(result.totalVulnerabilities).toBe(2);
    expect(result.advisories[0].package).toBe("pillow");
    expect(result.advisories[1].package).toBe("pillow");
    expect(result.advisories[0].id).toBe("PYSEC-2023-1");
    expect(result.advisories[1].id).toBe("PYSEC-2023-2");
  });

  it("cache key uses pm only — different severity calls do not trigger redundant audit runs", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    mockExecSafe.mockResolvedValue({
      stdout: JSON.stringify(NPM_AUDIT_RESPONSE),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 50,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);

    // First call with severity=high populates the cache
    await tool.handler({ severity: "high" });
    expect(mockExecSafe).toHaveBeenCalledTimes(1);

    mockExecSafe.mockClear();

    // Second call with severity=all should hit the cache — no second audit run
    const result = parse(await tool.handler({ severity: "all" }));
    expect(mockExecSafe).not.toHaveBeenCalled();
    // Both advisories should be visible with severity=all
    expect(result.totalVulnerabilities).toBe(2);
  });

  it("pip: returns available:false and install hint when binary not found", async () => {
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("requirements.txt"),
    );
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "ENOENT: pip-audit not found",
      exitCode: 127,
      timedOut: false,
      durationMs: 10,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.available).toBe(false);
    expect(result.packageManager).toBe("pip");
    expect(result.error).toContain("pip-audit");
    expect(result.error).toContain("pip install pip-audit");
  });

  it("auto and npm cache key dedup — only one subprocess run for auto then npm", async () => {
    // Regression: cacheKey was `pm` (raw "auto") not `detected` ("npm"), so two
    // calls with auto/npm within the TTL window spawned two audit subprocesses.
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith("package.json"),
    );
    const auditOutput = JSON.stringify(NPM_AUDIT_RESPONSE);
    mockExecSafe.mockResolvedValue({
      stdout: auditOutput,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      durationMs: 100,
    });

    const tool = createGetSecurityAdvisoriesTool(WORKSPACE);
    await tool.handler({ packageManager: "auto" });
    await tool.handler({ packageManager: "npm" });
    // Both calls resolve to npm; second should hit cache — only one execSafe call
    expect(mockExecSafe).toHaveBeenCalledTimes(1);
  });
});
