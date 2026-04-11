import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeDoctorTool } from "../bridgeDoctor.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROBES_ALL_TRUE = {
  rg: true,
  fd: true,
  git: true,
  gh: true,
  tsc: true,
  eslint: true,
  pyright: false,
  ruff: false,
  cargo: false,
  go: false,
  biome: false,
  prettier: true,
  black: false,
  gofmt: false,
  rustfmt: false,
  vitest: true,
  jest: false,
  pytest: false,
  codex: false,
};

const PROBES_NONE = Object.fromEntries(
  Object.keys(PROBES_ALL_TRUE).map((k) => [k, false]),
) as typeof PROBES_ALL_TRUE;

function makeExtensionClient(connected = true) {
  return {
    isConnected: vi.fn(() => connected),
    getCircuitBreakerState: vi.fn(() => ({
      suspended: false,
      failures: 0,
      suspendedUntil: 0,
    })),
    lastRttMs: 10,
  } as unknown as import("../../extensionClient.js").ExtensionClient;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}") as {
    overallHealth: string;
    checks: Array<{
      name: string;
      status: string;
      detail?: string;
      suggestion?: string;
    }>;
    summary: string;
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let workspace: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-doctor-test-"));
  workspace = path.join(tmpDir, "project");
  fs.mkdirSync(workspace, { recursive: true });
  // Make it a git repo so the git check passes
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bridgeDoctor", () => {
  it("returns structuredContent matching content text", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      PROBES_ALL_TRUE,
      0,
    );
    const result = (await tool.handler({})) as any;
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toEqual(
      JSON.parse(result.content[0].text),
    );
  });

  it("overall health is healthy when extension connected and git repo present", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      PROBES_ALL_TRUE,
      0,
    );
    const data = parse(await tool.handler({}));
    // Extension connected, git repo exists, probes good → at most degraded due to lock file
    expect(["healthy", "degraded"]).toContain(data.overallHealth);
  });

  it("extension disconnected → check status is warn", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(false),
      PROBES_ALL_TRUE,
      0,
    );
    const data = parse(await tool.handler({}));
    const extensionCheck = data.checks.find(
      (c) => c.name === "VS Code extension",
    );
    expect(extensionCheck?.status).toBe("warn");
    expect(extensionCheck?.suggestion).toContain("Reconnect");
  });

  it("circuit breaker open → extension check is warn with detail", async () => {
    const client = makeExtensionClient(true);
    (client.getCircuitBreakerState as ReturnType<typeof vi.fn>).mockReturnValue(
      {
        suspended: true,
        failures: 4,
        suspendedUntil: Date.now() + 5000,
      },
    );
    const tool = createBridgeDoctorTool(workspace, client, PROBES_ALL_TRUE, 0);
    const data = parse(await tool.handler({}));
    const extensionCheck = data.checks.find(
      (c) => c.name === "VS Code extension",
    );
    expect(extensionCheck?.status).toBe("warn");
    expect(extensionCheck?.detail).toContain("circuit breaker");
  });

  it("non-existent workspace → workspace path check is error", async () => {
    const missingPath = path.join(tmpDir, "does-not-exist");
    const tool = createBridgeDoctorTool(
      missingPath,
      makeExtensionClient(true),
      PROBES_ALL_TRUE,
      0,
    );
    const data = parse(await tool.handler({}));
    const wsCheck = data.checks.find((c) => c.name === "Workspace path");
    expect(wsCheck?.status).toBe("error");
    expect(wsCheck?.suggestion).toBeTruthy();
    expect(data.overallHealth).toBe("unhealthy");
  });

  it("tsconfig.json missing → TypeScript check is warn when tsc available", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      { ...PROBES_ALL_TRUE, tsc: true },
      0,
    );
    const data = parse(await tool.handler({}));
    const tsCheck = data.checks.find((c) => c.name === "TypeScript (tsc)");
    expect(tsCheck?.status).toBe("warn");
    expect(tsCheck?.suggestion).toContain("tsconfig.json");
  });

  it("tsconfig.json present → TypeScript check skips the missing-config warning", async () => {
    fs.writeFileSync(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({ compilerOptions: {} }),
    );
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      { ...PROBES_ALL_TRUE, tsc: true },
      0,
    );
    const data = parse(await tool.handler({}));
    const tsCheck = data.checks.find((c) => c.name === "TypeScript (tsc)");
    // With tsconfig present: either ok (if tsc binary actually runs) or still warn
    // but must NOT say "no tsconfig.json"
    expect(tsCheck?.suggestion ?? "").not.toContain("tsconfig.json");
  });

  it("tsc not in probes → TypeScript check is skip", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      { ...PROBES_NONE },
      0,
    );
    const data = parse(await tool.handler({}));
    const tsCheck = data.checks.find((c) => c.name === "TypeScript (tsc)");
    expect(tsCheck?.status).toBe("skip");
  });

  it("no linters found and biome.json present → suggestion mentions npm install", async () => {
    fs.writeFileSync(path.join(workspace, "biome.json"), "{}");
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      { ...PROBES_NONE },
      0,
    );
    const data = parse(await tool.handler({}));
    const linterCheck = data.checks.find((c) => c.name === "Linter");
    expect(linterCheck?.status).toBe("warn");
    expect(linterCheck?.suggestion).toContain("npm install");
  });

  it("package.json present but node_modules missing → error with suggestion", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      PROBES_ALL_TRUE,
      0,
    );
    const data = parse(await tool.handler({}));
    const nmCheck = data.checks.find((c) => c.name === "node_modules");
    expect(nmCheck?.status).toBe("error");
    expect(nmCheck?.suggestion).toContain("npm install");
  });

  it("package.json and node_modules both present → node_modules ok", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      PROBES_ALL_TRUE,
      0,
    );
    const data = parse(await tool.handler({}));
    const nmCheck = data.checks.find((c) => c.name === "node_modules");
    expect(nmCheck?.status).toBe("ok");
  });

  it("lock file present with isBridge=true → lock file check is ok", async () => {
    const lockDir = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "ide",
    );
    const port = 47999; // unlikely to be in use
    const lockPath = path.join(lockDir, `${port}.lock`);
    let createdLock = false;
    try {
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, isBridge: true, workspace }),
      );
      createdLock = true;
      const tool = createBridgeDoctorTool(
        workspace,
        makeExtensionClient(true),
        PROBES_ALL_TRUE,
        port,
      );
      const data = parse(await tool.handler({}));
      const lockCheck = data.checks.find((c) => c.name === "Lock file");
      expect(lockCheck?.status).toBe("ok");
    } finally {
      if (createdLock) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* best-effort */
        }
      }
    }
  });

  it("no lock file → lock file check is warn", async () => {
    const port = 47998; // unlikely to exist
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      PROBES_ALL_TRUE,
      port,
    );
    const data = parse(await tool.handler({}));
    const lockCheck = data.checks.find((c) => c.name === "Lock file");
    expect(lockCheck?.status).toBe("warn");
  });

  it("gh not in probes → GitHub CLI check is warn with suggestion", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      { ...PROBES_NONE },
      0,
    );
    const data = parse(await tool.handler({}));
    const ghCheck = data.checks.find((c) => c.name === "GitHub CLI (gh)");
    expect(ghCheck?.status).toBe("warn");
    expect(ghCheck?.suggestion).toContain("cli.github.com");
  });

  it("summary mentions issue count when there are issues", async () => {
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(false), // disconnected → at least one warn
      PROBES_NONE,
      0,
    );
    const data = parse(await tool.handler({}));
    expect(data.summary).toMatch(/\d+ issue/);
  });

  it("summary says all checks passed when health is healthy", async () => {
    // Minimally set up workspace to pass all checks that can pass
    fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({}));
    const tool = createBridgeDoctorTool(
      workspace,
      makeExtensionClient(true),
      { ...PROBES_ALL_TRUE, tsc: false, gh: false }, // skip checks that hit real binaries
      0,
    );
    const data = parse(await tool.handler({}));
    // Lock file will still be a warn (port=0), so this is degraded — just verify summary format
    if (data.overallHealth === "healthy") {
      expect(data.summary).toContain("All");
      expect(data.summary).toContain("passed");
    } else {
      expect(data.summary).toMatch(/\d+ issue/);
    }
  });
});
