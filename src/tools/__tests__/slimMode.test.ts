import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { registerAllTools, SLIM_TOOL_NAMES } from "../index.js";

// ── SLIM_TOOL_NAMES invariants ─────────────────────────────────────────────

describe("SLIM_TOOL_NAMES", () => {
  it("contains exactly 53 entries", () => {
    expect(SLIM_TOOL_NAMES.size).toBe(53);
  });

  it("all names match the valid tool name pattern", () => {
    for (const name of SLIM_TOOL_NAMES) {
      expect(name).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });

  it("contains the expected IDE-exclusive tools", () => {
    // Spot-check key members from each category
    expect(SLIM_TOOL_NAMES.has("getDiagnostics")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("goToDefinition")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("findReferences")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("startDebugging")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("evaluateInDebugger")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("executeVSCodeCommand")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("captureScreenshot")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("getBridgeStatus")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("getToolCapabilities")).toBe(true);
    expect(SLIM_TOOL_NAMES.has("bridgeDoctor")).toBe(true);
  });

  it("does not contain tools that duplicate Claude native capabilities", () => {
    // git
    expect(SLIM_TOOL_NAMES.has("gitCommit")).toBe(false);
    expect(SLIM_TOOL_NAMES.has("getGitStatus")).toBe(false);
    expect(SLIM_TOOL_NAMES.has("getGitDiff")).toBe(false);
    // terminal
    expect(SLIM_TOOL_NAMES.has("runCommand")).toBe(false);
    expect(SLIM_TOOL_NAMES.has("createTerminal")).toBe(false);
    expect(SLIM_TOOL_NAMES.has("sendTerminalCommand")).toBe(false);
    // file ops
    expect(SLIM_TOOL_NAMES.has("createFile")).toBe(false);
    expect(SLIM_TOOL_NAMES.has("editText")).toBe(false);
    expect(SLIM_TOOL_NAMES.has("searchWorkspace")).toBe(false);
    // HTTP
    expect(SLIM_TOOL_NAMES.has("sendHttpRequest")).toBe(false);
    // GitHub
    expect(SLIM_TOOL_NAMES.has("githubCreatePR")).toBe(false);
  });
});

// ── parseConfig flag ───────────────────────────────────────────────────────

describe("parseConfig --full flag", () => {
  it("defaults to slim mode (fullMode: false)", () => {
    const config = parseConfig(["node", "bridge"]);
    expect(config.fullMode).toBe(false);
  });

  it("sets fullMode: true when --full is passed", () => {
    const config = parseConfig(["node", "bridge", "--full"]);
    expect(config.fullMode).toBe(true);
  });
});

// ── registerAllTools filtering ─────────────────────────────────────────────

describe("registerAllTools tool set filtering", () => {
  function makeMinimalDeps() {
    const registered: string[] = [];
    const transport = {
      registerTool: vi.fn((schema: { name: string }) => {
        registered.push(schema.name);
      }),
    };

    const extensionClient = {
      isConnected: () => false,
      request: vi.fn(),
      requestOrNull: vi.fn(),
      latestAIComments: [],
      onExtensionDisconnected: null,
      onDiagnosticsChanged: null,
    };

    return { transport, extensionClient, registered };
  }

  function baseConfig(overrides: Partial<{ fullMode: boolean }> = {}) {
    return {
      workspace: "/tmp/test",
      workspaceFolders: ["/tmp/test"],
      ideName: "VS Code",
      editorCommand: null,
      port: null,
      bindAddress: "127.0.0.1",
      verbose: false,
      jsonl: false,
      linters: [],
      commandAllowlist: [],
      commandTimeout: 30_000,
      maxResultSize: 512,
      vscodeCommandAllowlist: [],
      activeWorkspaceFolder: "/tmp/test",
      gracePeriodMs: 30_000,
      autoTmux: false,
      claudeDriver: "none" as const,
      claudeBinary: "claude",
      automationEnabled: false,
      automationPolicyPath: null,
      toolRateLimit: 60,
      watch: false,
      plugins: [],
      pluginWatch: false,
      vps: false,
      db: false,
      allowPrivateHttp: false,
      fixedToken: null,
      issuerUrl: null,
      corsOrigins: [],
      auditLogPath: null,
      fullMode: false,
      maxSessions: 5,
      analyticsEnabled: null,
      githubDefaultRepo: null,
      ...overrides,
    };
  }

  it("slim mode registers exactly the SLIM_TOOL_NAMES set (no more, no less)", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    const probes = {
      gh: false,
      rg: false,
      fd: false,
      eslint: false,
      biome: false,
      tsc: false,
      pytest: false,
      jest: false,
      vitest: false,
      cargo: false,
      go: false,
      pyright: false,
      ruff: false,
    };

    registerAllTools(
      transport as never,
      baseConfig({ fullMode: false }),
      new Set(),
      probes as never,
      extensionClient as never,
    );

    const registeredSet = new Set(registered);
    // Every slim tool must be registered
    for (const name of SLIM_TOOL_NAMES) {
      expect(
        registeredSet.has(name),
        `slim tool "${name}" should be registered`,
      ).toBe(true);
    }
    // No non-slim tool should be registered
    for (const name of registered) {
      expect(
        SLIM_TOOL_NAMES.has(name),
        `"${name}" should not be registered in slim mode`,
      ).toBe(true);
    }
    expect(registered.length).toBe(SLIM_TOOL_NAMES.size);
  });

  it("full mode registers more tools than slim mode", () => {
    const {
      transport: t1,
      extensionClient: e1,
      registered: r1,
    } = makeMinimalDeps();
    const {
      transport: t2,
      extensionClient: e2,
      registered: r2,
    } = makeMinimalDeps();
    const probes = {
      gh: false,
      rg: false,
      fd: false,
      eslint: false,
      biome: false,
      tsc: false,
      pytest: false,
      jest: false,
      vitest: false,
      cargo: false,
      go: false,
      pyright: false,
      ruff: false,
    };

    registerAllTools(
      t1 as never,
      baseConfig({ fullMode: false }),
      new Set(),
      probes as never,
      e1 as never,
    );
    registerAllTools(
      t2 as never,
      baseConfig({ fullMode: true }),
      new Set(),
      probes as never,
      e2 as never,
    );

    expect(r2.length).toBeGreaterThan(r1.length);
    expect(r1.length).toBe(SLIM_TOOL_NAMES.size);
  });

  it("plugin tools bypass the slim filter in slim mode", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    const probes = {
      gh: false,
      rg: false,
      fd: false,
      eslint: false,
      biome: false,
      tsc: false,
      pytest: false,
      jest: false,
      vitest: false,
      cargo: false,
      go: false,
      pyright: false,
      ruff: false,
    };

    const pluginTool = {
      schema: {
        name: "myPlugin_custom",
        description: "",
        inputSchema: { type: "object", properties: {} },
      },
      handler: vi.fn(),
    };

    registerAllTools(
      transport as never,
      baseConfig({ fullMode: false }),
      new Set(),
      probes as never,
      extensionClient as never,
      undefined,
      "",
      undefined,
      undefined,
      null,
      "",
      [pluginTool as never],
    );

    expect(registered).toContain("myPlugin_custom");
  });
});
