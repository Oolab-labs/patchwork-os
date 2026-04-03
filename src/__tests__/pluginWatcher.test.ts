/**
 * Tests for PluginWatcher — fs.watch integration, debounce, reload, transport tracking.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import type { Config } from "../config.js";
import type { LoadedPlugin } from "../pluginLoader.js";
import { PluginWatcher } from "../pluginWatcher.js";
import type { McpTransport } from "../transport.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../pluginLoader.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../pluginLoader.js")>();
  return {
    ...orig,
    loadOnePluginFull: vi.fn(),
  };
});

import { loadOnePluginFull } from "../pluginLoader.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    workspace: process.cwd(),
    workspaceFolders: [process.cwd()],
    ideName: "Test",
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
    activeWorkspaceFolder: process.cwd(),
    gracePeriodMs: 30_000,
    autoTmux: false,
    claudeDriver: "none",
    claudeBinary: "claude",
    automationEnabled: false,
    automationPolicyPath: null,
    toolRateLimit: 60,
    watch: false,
    plugins: [],
    pluginWatch: false,
    ...overrides,
  };
}

interface LogCall {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
}

function makeLogger() {
  const calls: LogCall[] = [];
  return {
    calls,
    info: (msg: string) => calls.push({ level: "info", msg }),
    warn: (msg: string) => calls.push({ level: "warn", msg }),
    error: (msg: string) => calls.push({ level: "error", msg }),
    debug: (msg: string) => calls.push({ level: "debug", msg }),
    event: () => {},
    child: () => makeLogger(),
  } as unknown as import("../logger.js").Logger;
}

function makeTransport(): McpTransport {
  return {
    deregisterToolsByPrefix: vi.fn().mockReturnValue(1),
    replaceTool: vi.fn(),
  } as unknown as McpTransport;
}

function makeManifest(name = "test/plugin", prefix = "testPlugin") {
  return {
    schemaVersion: 1 as const,
    name,
    version: "1.0.0",
    entrypoint: "./index.mjs",
    toolNamePrefix: prefix,
  };
}

function makeLoadedPlugin(
  spec: string,
  tmpDir: string,
  toolName = "testPluginHello",
  manifestOverrides: Record<string, unknown> = {},
  timeoutMs?: number,
): LoadedPlugin {
  return {
    spec,
    pluginDir: tmpDir,
    manifest: {
      ...makeManifest(),
      ...manifestOverrides,
    } as LoadedPlugin["manifest"],
    tools: [
      {
        schema: {
          name: toolName,
          description: "Test tool",
          inputSchema: { type: "object", properties: {} },
        },
        handler: async () => ({ content: [{ type: "text", text: "hello" }] }),
        timeoutMs,
      },
    ],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PluginWatcher", () => {
  let tmpDir: string;
  let fsWatchSpy: MockInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-watcher-test-"));
    vi.useFakeTimers();
    fsWatchSpy = vi.spyOn(fs, "watch").mockReturnValue({
      close: vi.fn(),
    } as unknown as fs.FSWatcher);
    vi.mocked(loadOnePluginFull).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("start() calls fs.watch once per plugin", () => {
    const config = makeConfig();
    const logger = makeLogger();
    const watcher = new PluginWatcher(config, logger, vi.fn());

    const plugin1 = makeLoadedPlugin("./p1", tmpDir);
    const plugin2 = makeLoadedPlugin(
      "./p2",
      path.join(tmpDir, "sub"),
      "testPluginB",
    );

    watcher.start([plugin1, plugin2]);

    expect(fsWatchSpy).toHaveBeenCalledTimes(2);
    expect(fsWatchSpy).toHaveBeenCalledWith(
      tmpDir,
      { recursive: false },
      expect.any(Function),
    );

    watcher.stop();
  });

  it("reloadPlugin() success — deregisters old prefix, registers new tools, calls sendListChanged", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    const spec = "./my-plugin";
    const plugin = makeLoadedPlugin(spec, tmpDir);
    watcher.start([plugin]);

    const freshPlugin = makeLoadedPlugin(
      spec,
      tmpDir,
      "testPluginUpdated",
      {},
      500,
    );
    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(freshPlugin);

    const transport = makeTransport();
    watcher.addTransport(transport);

    await watcher.reloadPlugin(spec);

    expect(vi.mocked(transport.deregisterToolsByPrefix)).toHaveBeenCalledWith(
      "testPlugin",
    );
    expect(vi.mocked(transport.replaceTool)).toHaveBeenCalledWith(
      freshPlugin.tools[0]!.schema,
      freshPlugin.tools[0]!.handler,
      500,
    );
    expect(sendListChanged).toHaveBeenCalledTimes(1);

    // New tool should be returned by getTools()
    const tools = watcher.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("testPluginUpdated");

    watcher.stop();
  });

  it("reloadPlugin() null return — old tools unchanged, sendListChanged NOT called", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    const spec = "./my-plugin";
    const plugin = makeLoadedPlugin(spec, tmpDir);
    watcher.start([plugin]);

    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(null);

    const transport = makeTransport();
    watcher.addTransport(transport);

    await watcher.reloadPlugin(spec);

    expect(vi.mocked(transport.deregisterToolsByPrefix)).not.toHaveBeenCalled();
    expect(sendListChanged).not.toHaveBeenCalled();

    // Old tools should still be present
    const tools = watcher.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("testPluginHello");

    watcher.stop();
  });

  it("reloadPlugin() throws — old tools unchanged, sendListChanged NOT called", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    const spec = "./my-plugin";
    const plugin = makeLoadedPlugin(spec, tmpDir);
    watcher.start([plugin]);

    vi.mocked(loadOnePluginFull).mockRejectedValueOnce(
      new Error("import failed"),
    );

    const transport = makeTransport();
    watcher.addTransport(transport);

    await watcher.reloadPlugin(spec);

    expect(sendListChanged).not.toHaveBeenCalled();

    // Old tools unchanged
    const tools = watcher.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("testPluginHello");

    watcher.stop();
  });

  it("debouncing — 5 rapid scheduleReload calls → exactly 1 reload after 300ms", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    const spec = "./my-plugin";
    const plugin = makeLoadedPlugin(spec, tmpDir);
    watcher.start([plugin]);

    const freshPlugin = makeLoadedPlugin(spec, tmpDir, "testPluginUpdated");
    vi.mocked(loadOnePluginFull).mockResolvedValue(freshPlugin);

    // Trigger 5 rapid fs.watch callbacks by calling the watcher callback multiple times
    // We test debouncing by calling scheduleReload via the watcher (internal) — simulate
    // by triggering start with a plugin and manually firing the watcher callback.
    // Since scheduleReload is private, we test it via the public fs.watch mock callback.
    const watchCallback = fsWatchSpy.mock.calls[0]?.[2] as (
      event: string,
      filename: string,
    ) => void;
    assert(
      typeof watchCallback === "function",
      "watchCallback should be a function",
    );
    for (let i = 0; i < 5; i++) {
      watchCallback("change", "index.mjs");
    }

    // No reload yet
    expect(vi.mocked(loadOnePluginFull)).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(300);

    // Exactly 1 reload
    expect(vi.mocked(loadOnePluginFull)).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("stop() — clears all watchers and debounce timers", () => {
    const config = makeConfig();
    const logger = makeLogger();
    const watcher = new PluginWatcher(config, logger, vi.fn());

    const plugin = makeLoadedPlugin("./p1", tmpDir);
    watcher.start([plugin]);

    const mockWatcher = fsWatchSpy.mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>;
    };
    const watchCallback = fsWatchSpy.mock.calls[0]?.[2] as (
      event: string,
      filename: string,
    ) => void;
    watchCallback("change", "index.mjs");

    // Stop should clear timers (no reload should fire)
    watcher.stop();

    // The FSWatcher.close() should have been called
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);

    vi.mocked(loadOnePluginFull).mockResolvedValue(
      makeLoadedPlugin("./p1", tmpDir, "testPluginNew"),
    );
    vi.advanceTimersByTime(1000);

    expect(vi.mocked(loadOnePluginFull)).not.toHaveBeenCalled();
  });

  it("zero-transport reload — getTools() returns fresh plugin tools after reload", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    const spec = "./my-plugin";
    const plugin = makeLoadedPlugin(spec, tmpDir, "testPluginOld");
    watcher.start([plugin]);

    const freshPlugin = makeLoadedPlugin(spec, tmpDir, "testPluginFresh");
    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(freshPlugin);

    // No transports added — reload should still update loadedPlugins
    await watcher.reloadPlugin(spec);

    const tools = watcher.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("testPluginFresh");

    watcher.stop();
  });

  it("removeTransport — removed transport not mutated on reload", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    const spec = "./my-plugin";
    const plugin = makeLoadedPlugin(spec, tmpDir);
    watcher.start([plugin]);

    const freshPlugin = makeLoadedPlugin(spec, tmpDir, "testPluginUpdated");
    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(freshPlugin);

    const transport = makeTransport();
    watcher.addTransport(transport);
    watcher.removeTransport(transport);

    await watcher.reloadPlugin(spec);

    // Transport was removed, so it should not be mutated
    expect(vi.mocked(transport.deregisterToolsByPrefix)).not.toHaveBeenCalled();
    expect(vi.mocked(transport.replaceTool)).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("getTools() returns flat list of all plugin tools", () => {
    const config = makeConfig();
    const logger = makeLogger();
    const watcher = new PluginWatcher(config, logger, vi.fn());

    const plugin1 = makeLoadedPlugin("./p1", tmpDir, "testPluginA");
    const plugin2: LoadedPlugin = {
      spec: "./p2",
      pluginDir: path.join(tmpDir, "sub"),
      manifest: makeManifest(
        "other/plugin",
        "otherPlugin",
      ) as LoadedPlugin["manifest"],
      tools: [
        {
          schema: {
            name: "otherPluginFoo",
            description: "foo",
            inputSchema: { type: "object" },
          },
          handler: async () => ({ content: [{ type: "text", text: "foo" }] }),
        },
        {
          schema: {
            name: "otherPluginBar",
            description: "bar",
            inputSchema: { type: "object" },
          },
          handler: async () => ({ content: [{ type: "text", text: "bar" }] }),
        },
      ],
    };

    watcher.start([plugin1, plugin2]);

    const tools = watcher.getTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.schema.name)).toContain("testPluginA");
    expect(tools.map((t) => t.schema.name)).toContain("otherPluginFoo");
    expect(tools.map((t) => t.schema.name)).toContain("otherPluginBar");

    watcher.stop();
  });
});
