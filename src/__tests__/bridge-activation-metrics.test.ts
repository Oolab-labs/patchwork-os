import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { makeConfig as buildConfig } from "./helpers/fixtures.js";

const activationMetricsModule = await vi.hoisted(async () => ({
  recordRecipeRun: vi.fn(),
}));

const yamlRunnerModule = await vi.hoisted(async () => ({
  dispatchRecipe: vi.fn(),
  loadYamlRecipe: vi.fn(),
  buildChainedDeps: vi.fn(() => ({})),
}));

const pluginLoaderModule = await vi.hoisted(async () => ({
  loadPlugins: vi.fn(async (): Promise<unknown[]> => []),
  loadPluginsFull: vi.fn(async (): Promise<unknown[]> => []),
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
  loadPlugins: pluginLoaderModule.loadPlugins,
  loadPluginsFull: pluginLoaderModule.loadPluginsFull,
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
  return buildConfig({
    workspace,
    workspaceFolders: [workspace],
    ideName: "Test",
    maxResultSize: 512 * 1024,
    gracePeriodMs: 1_000,
    driver: "subprocess",
    toolRateLimit: 10,
    fixedToken: "bridge-fixed-token",
    fullMode: false,
    analyticsEnabled: false,
    wsPingIntervalMs: 0,
    lspVerbosity: "minimal",
  });
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
    pluginLoaderModule.loadPlugins.mockReset();
    pluginLoaderModule.loadPlugins.mockImplementation(async () => []);
    pluginLoaderModule.loadPluginsFull.mockReset();
    pluginLoaderModule.loadPluginsFull.mockImplementation(async () => []);
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

  it("forwards config.trustedProxies into the underlying Server constructor", async () => {
    // Regression guard for PR #383's dead-code wiring: the constructor
    // parameter on Server existed but bridge.ts:174 was passing only three
    // args, so trustedProxies was always []. Reverse-proxy operators got
    // no rate-limit fix.
    const workspace = fs.mkdtempSync(path.join(tempDir, "workspace-tp-"));
    const cfg = makeConfig(workspace);
    cfg.trustedProxies = ["127.0.0.1", "10.0.0.1"];
    const bridge = new Bridge(cfg);
    try {
      const proxies = (
        bridge as unknown as { server: { trustedProxies: string[] } }
      ).server.trustedProxies;
      expect(proxies).toEqual(["127.0.0.1", "10.0.0.1"]);
    } finally {
      await bridge.stop();
    }
  });

  it("wires sessionDetailFn in start() so GET /sessions/:id is not a dead endpoint (audit 2026-06-08 server-1)", async () => {
    // Regression guard for the same class as the sessionsFn bug: the Fn was
    // declared on Server but never assigned in bridge.ts, so /sessions/:id
    // 404'd forever. A route-with-stub test can't catch a missing wire.
    const workspace = fs.mkdtempSync(path.join(tempDir, "workspace-sd-"));
    const bridge = new Bridge(makeConfig(workspace));
    try {
      await bridge.start();
      const server = (
        bridge as unknown as {
          server: {
            sessionDetailFn: ((id: string) => { summary: unknown }) | null;
          };
        }
      ).server;
      expect(typeof server.sessionDetailFn).toBe("function");
      // No sessions connected → unknown id → summary:null (route → 404).
      expect(server.sessionDetailFn?.("nosuch")?.summary).toBeNull();
    } finally {
      await bridge.stop();
    }
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

  it("does not report ready until plugin loading resolves (regression: sessions could connect before plugin tools were registered)", async () => {
    let resolveLoadPlugins!: (tools: unknown[]) => void;
    pluginLoaderModule.loadPlugins.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveLoadPlugins = resolve;
        }),
    );

    const workspace = fs.mkdtempSync(path.join(tempDir, "workspace-ready-"));
    const bridge = new Bridge(makeConfig(workspace));

    try {
      const startPromise = bridge.start();

      // Let start() run up to (and block on) the loadPlugins() await, without
      // letting it resolve yet. A few microtask turns is enough since nothing
      // between probeAll() and loadPlugins() awaits anything real.
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect((bridge as unknown as { ready: boolean }).ready).toBe(false);

      resolveLoadPlugins([]);
      await startPromise;

      expect((bridge as unknown as { ready: boolean }).ready).toBe(true);
    } finally {
      await bridge.stop();
    }
  });
});
