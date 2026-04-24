import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";

const activationMetricsModule = await vi.hoisted(async () => ({
  recordRecipeRun: vi.fn(),
}));

const yamlRunnerModule = await vi.hoisted(async () => ({
  dispatchRecipe: vi.fn(),
  loadYamlRecipe: vi.fn(),
  buildChainedDeps: vi.fn(() => ({})),
}));

vi.mock("../activationMetrics.js", () => activationMetricsModule);
vi.mock("../bridgeToken.js", () => ({
  loadOrCreateBridgeToken: vi.fn(() => "bridge-test-token"),
}));
vi.mock("../drivers/index.js", () => ({
  createDriver: vi.fn(() => ({ name: "mock-driver" })),
}));
vi.mock("../probe.js", () => ({
  probeAll: vi.fn(async () => ({})),
}));
vi.mock("../pluginLoader.js", () => ({
  loadPlugins: vi.fn(async () => []),
  loadPluginsFull: vi.fn(async () => []),
}));
vi.mock("../bridgeToolsRules.js", () => ({
  repairBridgeToolsRulesIfStale: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));
vi.mock("../streamableHttp.js", () => ({
  StreamableHttpHandler: class {
    handle(): Promise<void> {
      return Promise.resolve();
    }
    close(): void {}
  },
}));
vi.mock("../claudeOrchestrator.js", () => ({
  ClaudeOrchestrator: class {
    runAndWait(): Promise<{ output: string }> {
      return Promise.resolve({ output: "ok" });
    }
    loadPersistedTasks(): Promise<void> {
      return Promise.resolve();
    }
    enqueue(): string {
      return "task-123";
    }
    getTask(): null {
      return null;
    }
    persistTasks(): Promise<void> {
      return Promise.resolve();
    }
    flushTasksToDisk(): void {}
    list(): [] {
      return [];
    }
    cancel(): void {}
  },
}));
vi.mock("../recipes/yamlRunner.js", () => yamlRunnerModule);
vi.mock("../recipesHttp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recipesHttp.js")>();
  return {
    ...actual,
    findYamlRecipePath: vi.fn(() => "/tmp/demo.yaml"),
    loadRecipePrompt: vi.fn(() => null),
  };
});

const { Bridge } = await import("../bridge.js");

function makeConfig(workspace: string): Config {
  return {
    workspace,
    workspaceFolders: [workspace],
    ideName: "Test",
    editorCommand: null,
    port: null,
    bindAddress: "127.0.0.1",
    verbose: false,
    jsonl: false,
    linters: [],
    commandAllowlist: [],
    commandTimeout: 30_000,
    maxResultSize: 512 * 1024,
    vscodeCommandAllowlist: [],
    configFilePath: null,
    activeWorkspaceFolder: workspace,
    gracePeriodMs: 1_000,
    autoTmux: false,
    driver: "subprocess",
    claudeBinary: "claude",
    antBinary: "ant",
    automationEnabled: false,
    automationPolicyPath: null,
    toolRateLimit: 10,
    approvalGate: "off",
    managedSettingsPath: null,
    approvalWebhookUrl: null,
    watch: false,
    plugins: [],
    pluginWatch: false,
    vps: false,
    db: false,
    allowPrivateHttp: false,
    fixedToken: "bridge-fixed-token",
    issuerUrl: null,
    oauthTokenTtlMs: 86_400_000,
    corsOrigins: [],
    auditLogPath: null,
    fullMode: false,
    maxSessions: 5,
    analyticsEnabled: false,
    githubDefaultRepo: null,
    wsPingIntervalMs: 0,
    lspVerbosity: "minimal",
    recipeMaxConcurrency: 4,
    recipeMaxDepth: 3,
    recipeDryRun: false,
    lazyTools: false,
  };
}

describe("Bridge activation metrics", () => {
  let tempDir = "";
  let previousHome: string | undefined;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-activation-"));
    previousHome = process.env.HOME;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tempDir;
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, ".claude");
    activationMetricsModule.recordRecipeRun.mockReset();
    yamlRunnerModule.loadYamlRecipe.mockReset();
    yamlRunnerModule.dispatchRecipe.mockReset();
    yamlRunnerModule.buildChainedDeps.mockClear();
    yamlRunnerModule.loadYamlRecipe.mockReturnValue({
      name: "demo",
      trigger: { type: "manual" },
      steps: [],
    });
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records a successful YAML recipe run", async () => {
    yamlRunnerModule.dispatchRecipe.mockResolvedValue({
      success: true,
      summary: { total: 1 },
    });

    const workspace = fs.mkdtempSync(path.join(tempDir, "workspace-"));
    const bridge = new Bridge(makeConfig(workspace));

    try {
      await bridge.start();
      const result = await (
        bridge as unknown as {
          server: {
            runRecipeFn?: (
              name: string,
            ) => Promise<{ ok: boolean; taskId?: string }>;
          };
        }
      ).server.runRecipeFn?.("demo");

      expect(result).toMatchObject({ ok: true, taskId: expect.any(String) });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(yamlRunnerModule.dispatchRecipe).toHaveBeenCalledTimes(1);
      expect(activationMetricsModule.recordRecipeRun).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });

  it("does not record a failed YAML recipe run", async () => {
    yamlRunnerModule.dispatchRecipe.mockResolvedValue({
      success: false,
      summary: { total: 1 },
    });

    const workspace = fs.mkdtempSync(path.join(tempDir, "workspace-"));
    const bridge = new Bridge(makeConfig(workspace));

    try {
      await bridge.start();
      await (
        bridge as unknown as {
          server: {
            runRecipeFn?: (
              name: string,
            ) => Promise<{ ok: boolean; taskId?: string }>;
          };
        }
      ).server.runRecipeFn?.("demo");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(yamlRunnerModule.dispatchRecipe).toHaveBeenCalledTimes(1);
      expect(activationMetricsModule.recordRecipeRun).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
    }
  });
});
