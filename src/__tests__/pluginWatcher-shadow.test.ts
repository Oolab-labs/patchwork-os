/**
 * Bug 1 — Plugin hot-reload must NOT shadow built-in tool names.
 *
 * `loadPluginsFull` seeds the collision-detection set with `getBuiltInToolNames()`.
 * Hot-reload via `PluginWatcher._reloadPluginInner` must apply the same defense:
 * a plugin edited mid-flight to declare e.g. `toolNamePrefix: "git"` and register
 * `gitPush` (a built-in tool) MUST be rejected, otherwise `transport.replaceTool`
 * silently overwrites the built-in.
 */

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

vi.mock("../pluginLoader.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../pluginLoader.js")>();
  return {
    ...orig,
    loadOnePluginFull: vi.fn(),
  };
});

import { loadOnePluginFull } from "../pluginLoader.js";

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

function makeLogger() {
  const calls: Array<{ level: string; msg: string }> = [];
  return {
    calls,
    info: (msg: string) => calls.push({ level: "info", msg }),
    warn: (msg: string) => calls.push({ level: "warn", msg }),
    error: (msg: string) => calls.push({ level: "error", msg }),
    debug: (msg: string) => calls.push({ level: "debug", msg }),
    event: () => {},
    child: () =>
      ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        event: () => {},
        child: () => ({}) as never,
      }) as never,
  } as unknown as import("../logger.js").Logger;
}

function makeTransport(): McpTransport {
  return {
    deregisterToolsByPrefix: vi.fn().mockReturnValue(1),
    replaceTool: vi.fn(),
  } as unknown as McpTransport;
}

function makePlugin(
  spec: string,
  pluginDir: string,
  toolName: string,
  prefix: string,
): LoadedPlugin {
  return {
    spec,
    pluginDir,
    manifest: {
      schemaVersion: 1,
      name: "shadow/plugin",
      version: "1.0.0",
      entrypoint: "./index.mjs",
      toolNamePrefix: prefix,
    } as LoadedPlugin["manifest"],
    tools: [
      {
        schema: {
          name: toolName,
          description: "Test tool",
          inputSchema: { type: "object", properties: {} },
        },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  };
}

describe("PluginWatcher hot-reload — built-in tool shadowing", () => {
  let tmpDir: string;
  let fsWatchSpy: MockInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-shadow-test-"));
    fsWatchSpy = vi.spyOn(fs, "watch").mockReturnValue({
      close: vi.fn(),
    } as unknown as fs.FSWatcher);
    vi.mocked(loadOnePluginFull).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hot-reload that registers a built-in tool name (gitPush) is rejected — collision check seeded with built-ins", async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const sendListChanged = vi.fn();
    const watcher = new PluginWatcher(config, logger, sendListChanged);

    // Original plugin uses an innocuous prefix and tool name.
    const spec = "./shadow-plugin";
    const original = makePlugin(spec, tmpDir, "shadowFooBar", "shadowFoo");
    watcher.start([original]);

    const transport = makeTransport();
    watcher.addTransport(transport);

    // Mock loadOnePluginFull to capture the `existingNames` Set the watcher
    // passes in. The real loader uses that Set to detect collisions; if the
    // Set does NOT contain built-ins, a hot-reload trying to register
    // `gitPush` will silently succeed and shadow the built-in.
    let capturedExistingNames: Set<string> | null = null;
    vi.mocked(loadOnePluginFull).mockImplementation(
      async (_spec, _config, _logger, existingNames) => {
        capturedExistingNames = existingNames ?? null;
        // Simulate the loader rejecting the plugin (returning null) when
        // a name collision exists. If existingNames doesn't include built-ins,
        // the simulated rejection won't fire and we'll see the shadow.
        if (existingNames?.has("gitPush")) {
          // Loader's actual behavior — log + return null
          return null;
        }
        // Otherwise the loader would happily produce a fresh plugin that
        // registers `gitPush`, leaking past collision detection.
        return makePlugin(spec, tmpDir, "gitPush", "git");
      },
    );

    await watcher.reloadPlugin(spec);

    // The watcher must have passed an existingNames set that contains
    // built-in tool names (e.g. gitPush, getDiagnostics, runCommand).
    expect(capturedExistingNames).not.toBeNull();
    expect(capturedExistingNames!.has("gitPush")).toBe(true);
    expect(capturedExistingNames!.has("getDiagnostics")).toBe(true);

    // Because the simulated loader returned null (collision detected),
    // transport.replaceTool must NOT have been called for the shadow tool.
    const replaceCalls = vi.mocked(transport.replaceTool).mock.calls;
    const shadowed = replaceCalls.find((c) => {
      const schema = c[0] as { name?: string } | undefined;
      return schema?.name === "gitPush";
    });
    expect(shadowed).toBeUndefined();

    // Old tools should remain unchanged after the rejected reload.
    const tools = watcher.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("shadowFooBar");

    watcher.stop();
  });
});
