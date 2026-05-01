/**
 * Regression: catches the silent-regression class where a deps argument
 * is dropped from a `registerAllTools` call site and certain tools fail
 * to register (e.g. `ctxSaveTrace` requires `decisionTraceLog`,
 * `getCommitsForIssue` requires `commitIssueLinkLog`, `enrichCommit`
 * uses `commitIssueLinkLog`, `runTests` invokes `automationHooks`).
 *
 * Pre-fix the 18-positional-param signature was all-optional after
 * position 5, so dropping a tail dep silently disabled tools without
 * any TypeScript error.
 *
 * This test calls `registerAllTools` via the new options-object overload
 * with TRUTHY values for the gating deps and asserts the gated tools
 * register.
 */

import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../tools/index.js";

function makeMinimalDeps() {
  const registered: string[] = [];
  const transport = {
    registerTool: vi.fn((schema: { name: string }) => {
      registered.push(schema.name);
    }),
    applyToolCategories: vi.fn(),
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
    fullMode: true,
    maxSessions: 5,
    analyticsEnabled: null,
    githubDefaultRepo: null,
    antBinary: "ant",
    oauthTokenTtlMs: 86_400_000,
    wsPingIntervalMs: 10_000,
    lspVerbosity: "normal" as const,
    ...overrides,
  };
}

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

describe("registerAllTools — options-object overload", () => {
  it("accepts a single ToolContext object and registers tools", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    registerAllTools({
      transport: transport as never,
      config: baseConfig() as never,
      openedFiles: new Set<string>(),
      probes: probes as never,
      extensionClient: extensionClient as never,
    });
    // Should register at least the slim core tools.
    expect(registered.length).toBeGreaterThan(10);
    expect(registered).toContain("getDiagnostics");
  });

  it("registers ctxSaveTrace when decisionTraceLog is provided", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    const decisionTraceLog = {
      append: vi.fn(),
      query: vi.fn(() => []),
    };
    registerAllTools({
      transport: transport as never,
      config: baseConfig() as never,
      openedFiles: new Set<string>(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      decisionTraceLog: decisionTraceLog as never,
    });
    expect(registered).toContain("ctxSaveTrace");
  });

  it("does NOT register ctxSaveTrace when decisionTraceLog is missing", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    registerAllTools({
      transport: transport as never,
      config: baseConfig() as never,
      openedFiles: new Set<string>(),
      probes: probes as never,
      extensionClient: extensionClient as never,
    });
    expect(registered).not.toContain("ctxSaveTrace");
  });

  it("registers getCommitsForIssue and enrichCommit when commitIssueLinkLog is provided", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    const commitIssueLinkLog = {
      append: vi.fn(),
      query: vi.fn(() => []),
    };
    registerAllTools({
      transport: transport as never,
      config: baseConfig() as never,
      openedFiles: new Set<string>(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      commitIssueLinkLog: commitIssueLinkLog as never,
    });
    expect(registered).toContain("getCommitsForIssue");
    expect(registered).toContain("enrichCommit");
  });

  it("registers runTests in full mode regardless of automationHooks", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    const automationHooks = {
      handleTestRun: vi.fn(),
      handleGitCommit: vi.fn(),
      handleBranchCheckout: vi.fn(),
      handleGitPull: vi.fn(),
      handleGitPush: vi.fn(),
      handlePullRequest: vi.fn(),
    };
    registerAllTools({
      transport: transport as never,
      config: baseConfig() as never,
      openedFiles: new Set<string>(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      automationHooks: automationHooks as never,
    });
    expect(registered).toContain("runTests");
  });

  it("positional signature still works (back-compat)", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    registerAllTools(
      transport as never,
      baseConfig() as never,
      new Set<string>(),
      probes as never,
      extensionClient as never,
    );
    expect(registered.length).toBeGreaterThan(10);
    expect(registered).toContain("getDiagnostics");
  });

  it("options-object form registers all four context-platform gated tools when full deps provided", () => {
    const { transport, extensionClient, registered } = makeMinimalDeps();
    registerAllTools({
      transport: transport as never,
      config: baseConfig() as never,
      openedFiles: new Set<string>(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      automationHooks: {
        handleTestRun: vi.fn(),
        handleGitCommit: vi.fn(),
        handleBranchCheckout: vi.fn(),
        handleGitPull: vi.fn(),
        handleGitPush: vi.fn(),
        handlePullRequest: vi.fn(),
      } as never,
      commitIssueLinkLog: { append: vi.fn(), query: vi.fn(() => []) } as never,
      recipeRunLog: { append: vi.fn(), query: vi.fn(() => []) } as never,
      decisionTraceLog: { append: vi.fn(), query: vi.fn(() => []) } as never,
    });
    expect(registered).toContain("ctxSaveTrace");
    expect(registered).toContain("getCommitsForIssue");
    expect(registered).toContain("enrichCommit");
    expect(registered).toContain("runTests");
  });
});
