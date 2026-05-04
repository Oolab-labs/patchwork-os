/**
 * Tests for the plugin loader — discovery, validation, collision checks,
 * and error isolation.
 *
 * Each test creates a temporary directory with a mock plugin and verifies
 * the loader's response. No live bridge or transport is required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import {
  loadOnePluginFull,
  loadPlugins,
  loadPluginsFull,
} from "../pluginLoader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  // Tests only use a small subset of Config; cast through unknown so the
  // helper doesn't have to track every required field as Config grows.
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
    driver: "none",
    claudeBinary: "claude",
    antBinary: "ant",
    automationEnabled: false,
    automationPolicyPath: null,
    toolRateLimit: 60,
    watch: false,
    plugins: [],
    pluginWatch: false,
    ...overrides,
  } as unknown as Config;
}

interface LogCall {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
}

type TestLogger = import("../logger.js").Logger & { calls: LogCall[] };

function makeLogger(): TestLogger {
  const calls: LogCall[] = [];
  return {
    calls,
    info: (msg: string) => calls.push({ level: "info", msg }),
    warn: (msg: string) => calls.push({ level: "warn", msg }),
    error: (msg: string) => calls.push({ level: "error", msg }),
    debug: (msg: string) => calls.push({ level: "debug", msg }),
    event: () => {},
    child: () => makeLogger(),
  } as unknown as TestLogger;
}

function makeManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "test/plugin",
    version: "1.0.0",
    entrypoint: "./index.mjs",
    toolNamePrefix: "testPlugin",
    ...overrides,
  };
}

function writePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  entrypointCode: string,
): void {
  fs.writeFileSync(
    path.join(dir, "claude-ide-bridge-plugin.json"),
    JSON.stringify(manifest),
  );
  const entryFile = manifest.entrypoint as string;
  fs.writeFileSync(path.join(dir, entryFile), entrypointCode);
}

function validRegisterCode(toolName = "testPluginHello"): string {
  return `
export function register() {
  return {
    tools: [{
      schema: {
        name: "${toolName}",
        description: "Test tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: async () => ({ content: [{ type: "text", text: "hello" }] }),
    }],
  };
}
`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadPlugins", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns empty array when no plugins specified", async () => {
    const tools = await loadPlugins([], makeConfig(), makeLogger());
    expect(tools).toEqual([]);
  });

  it("happy path: loads a valid plugin and returns its tools", async () => {
    const pluginDir = path.join(tmpDir, "my-plugin");
    fs.mkdirSync(pluginDir);
    writePlugin(pluginDir, makeManifest(), validRegisterCode());

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("testPluginHello");
    expect(typeof tools[0]!.handler).toBe("function");
    expect(log.calls.some((c) => c.level === "warn")).toBe(false);
  });

  it("warns and skips when manifest file is missing", async () => {
    const pluginDir = path.join(tmpDir, "no-manifest");
    fs.mkdirSync(pluginDir);

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("manifest not found"),
      ),
    ).toBe(true);
  });

  it("warns and skips on invalid JSON in manifest", async () => {
    const pluginDir = path.join(tmpDir, "bad-json");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "claude-ide-bridge-plugin.json"),
      "{ not valid json",
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("failed to parse"),
      ),
    ).toBe(true);
  });

  it("warns and skips when schemaVersion is unsupported", async () => {
    const pluginDir = path.join(tmpDir, "bad-schema");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest({ schemaVersion: 99 }),
      validRegisterCode(),
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) =>
          c.level === "warn" && c.msg.includes("unsupported schemaVersion"),
      ),
    ).toBe(true);
  });

  it("warns and skips when toolNamePrefix is missing", async () => {
    const pluginDir = path.join(tmpDir, "no-prefix");
    fs.mkdirSync(pluginDir);
    const m = makeManifest();
    m.toolNamePrefix = undefined;
    writePlugin(pluginDir, m, validRegisterCode());

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("toolNamePrefix"),
      ),
    ).toBe(true);
  });

  it("warns and skips when toolNamePrefix has invalid format", async () => {
    const pluginDir = path.join(tmpDir, "bad-prefix");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest({ toolNamePrefix: "123bad" }),
      validRegisterCode(),
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("toolNamePrefix"),
      ),
    ).toBe(true);
  });

  it("warns and skips when entrypoint import fails", async () => {
    const pluginDir = path.join(tmpDir, "bad-import");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      `throw new Error("intentional load error");`,
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("failed to import"),
      ),
    ).toBe(true);
  });

  it("warns and skips when register() throws", async () => {
    const pluginDir = path.join(tmpDir, "register-throws");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      `export function register() { throw new Error("register failed"); }`,
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("register() threw"),
      ),
    ).toBe(true);
  });

  it("warns and skips when register() returns wrong shape", async () => {
    const pluginDir = path.join(tmpDir, "bad-return");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      "export function register() { return { notTools: [] }; }",
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("must return { tools"),
      ),
    ).toBe(true);
  });

  it("warns but still loads when register() returns 0 tools", async () => {
    const pluginDir = path.join(tmpDir, "zero-tools");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      "export function register() { return { tools: [] }; }",
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some((c) => c.level === "warn" && c.msg.includes("0 tools")),
    ).toBe(true);
  });

  it("rejects entire plugin when a tool name doesn't match declared prefix", async () => {
    const pluginDir = path.join(tmpDir, "wrong-prefix");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      validRegisterCode("wrongPrefixHello"),
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) =>
          c.level === "warn" &&
          c.msg.includes("does not start with declared prefix"),
      ),
    ).toBe(true);
  });

  it("rejects plugin when a tool name has invalid characters", async () => {
    const pluginDir = path.join(tmpDir, "invalid-name");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      validRegisterCode("testPlugin-invalid"),
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toEqual([]);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("invalid name"),
      ),
    ).toBe(true);
  });

  it("rejects plugin when a tool name collides with an already-registered name (cross-plugin)", async () => {
    const dir1 = path.join(tmpDir, "plugin1");
    const dir2 = path.join(tmpDir, "plugin2");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    writePlugin(
      dir1,
      makeManifest({ name: "test/p1", toolNamePrefix: "testPlugin" }),
      validRegisterCode("testPluginHello"),
    );
    writePlugin(
      dir2,
      makeManifest({ name: "test/p2", toolNamePrefix: "testPlugin" }),
      validRegisterCode("testPluginHello"),
    );

    const log = makeLogger();
    const tools = await loadPlugins([dir1, dir2], makeConfig(), log);

    // First plugin loads fine; second is rejected due to collision
    expect(tools).toHaveLength(1);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("collides with"),
      ),
    ).toBe(true);
  });

  it("deduplicates plugins at the same resolved path", async () => {
    const pluginDir = path.join(tmpDir, "dedup");
    fs.mkdirSync(pluginDir);
    writePlugin(pluginDir, makeManifest(), validRegisterCode());

    const log = makeLogger();
    // Pass the same path twice
    const tools = await loadPlugins([pluginDir, pluginDir], makeConfig(), log);

    expect(tools).toHaveLength(1);
    expect(
      log.calls.some((c) => c.level === "warn" && c.msg.includes("duplicate")),
    ).toBe(true);
  });

  it("loads two plugins with disjoint prefixes — all tools registered", async () => {
    const dir1 = path.join(tmpDir, "p1");
    const dir2 = path.join(tmpDir, "p2");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    writePlugin(
      dir1,
      makeManifest({ name: "test/p1", toolNamePrefix: "alphaPlugin" }),
      validRegisterCode("alphaPluginFoo"),
    );
    writePlugin(
      dir2,
      makeManifest({ name: "test/p2", toolNamePrefix: "betaPlugin" }),
      validRegisterCode("betaPluginBar"),
    );

    const tools = await loadPlugins([dir1, dir2], makeConfig(), makeLogger());

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.schema.name).sort()).toEqual([
      "alphaPluginFoo",
      "betaPluginBar",
    ]);
  });

  it("warns when minBridgeVersion is newer than running version but still loads", async () => {
    const pluginDir = path.join(tmpDir, "future-version");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest({ minBridgeVersion: "99.0.0" }),
      validRegisterCode(),
    );

    const log = makeLogger();
    const tools = await loadPlugins([pluginDir], makeConfig(), log);

    expect(tools).toHaveLength(1);
    expect(
      log.calls.some(
        (c) => c.level === "warn" && c.msg.includes("requires bridge >="),
      ),
    ).toBe(true);
  });

  it("does not expose authToken in PluginContext", async () => {
    const pluginDir = path.join(tmpDir, "ctx-check");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      `
export function register(ctx) {
  const hasToken = "authToken" in ctx.config;
  return {
    tools: [{
      schema: {
        name: "testPluginCtx",
        description: "ctx test",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: async () => ({ content: [{ type: "text", text: String(hasToken) }] }),
    }],
  };
}
`,
    );

    const tools = await loadPlugins([pluginDir], makeConfig(), makeLogger());
    expect(tools).toHaveLength(1);

    // Call the handler and check that authToken was NOT in ctx.config
    const result = await tools[0]!.handler({});
    expect(result.content[0]!.text).toBe("false");
  });

  it("accepts default export as well as named register export", async () => {
    const pluginDir = path.join(tmpDir, "default-export");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      `
export default function(ctx) {
  return {
    tools: [{
      schema: { name: "testPluginDefault", description: "d", inputSchema: { type: "object" } },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }],
  };
}
`,
    );

    const tools = await loadPlugins([pluginDir], makeConfig(), makeLogger());
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("testPluginDefault");
  });

  it("one failing plugin does not prevent other plugins from loading", async () => {
    const bad = path.join(tmpDir, "bad");
    const good = path.join(tmpDir, "good");
    fs.mkdirSync(bad);
    fs.mkdirSync(good);

    // bad has no manifest
    writePlugin(
      good,
      makeManifest({ name: "test/good", toolNamePrefix: "goodPlugin" }),
      validRegisterCode("goodPluginHello"),
    );

    const log = makeLogger();
    const tools = await loadPlugins([bad, good], makeConfig(), log);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("goodPluginHello");
    expect(log.calls.some((c) => c.level === "warn")).toBe(true);
  });
});

describe("loadOnePluginFull", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-full-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns LoadedPlugin with spec, pluginDir, manifest, and tools", async () => {
    const pluginDir = path.join(tmpDir, "my-plugin");
    fs.mkdirSync(pluginDir);
    writePlugin(pluginDir, makeManifest(), validRegisterCode());

    const log = makeLogger();
    const result = await loadOnePluginFull(pluginDir, makeConfig(), log);

    expect(result).not.toBeNull();
    expect(result!.spec).toBe(pluginDir);
    expect(result!.pluginDir).toBe(pluginDir);
    expect(result!.manifest.name).toBe("test/plugin");
    expect(result!.manifest.toolNamePrefix).toBe("testPlugin");
    expect(result!.tools).toHaveLength(1);
    expect(result!.tools[0]!.schema.name).toBe("testPluginHello");
  });

  it("returns null when manifest is missing", async () => {
    const pluginDir = path.join(tmpDir, "no-manifest");
    fs.mkdirSync(pluginDir);

    const log = makeLogger();
    const result = await loadOnePluginFull(pluginDir, makeConfig(), log);

    expect(result).toBeNull();
  });

  it("two calls to loadOnePluginFull return fresh module state (cache-busting)", async () => {
    // Write a plugin that increments a counter on each import via a module-level variable
    // Since Node caches ESM modules by URL, cache-busting via ?t= ensures fresh state.
    // We test the observable behavior: second load does not reuse the first module's state.
    // If cache-busting works: each load gets its own callCount=0, register() sets it to 1,
    // so both handlers return "1". If cache-busting is broken (same module shared), the
    // second call would return "2" because callCount accumulated across calls.
    const pluginDir = path.join(tmpDir, "cache-bust");
    fs.mkdirSync(pluginDir);
    writePlugin(
      pluginDir,
      makeManifest(),
      `
let callCount = 0;
export function register() {
  callCount++;
  return {
    tools: [{
      schema: { name: "testPluginCb", description: "cb", inputSchema: { type: "object" } },
      handler: async () => ({ content: [{ type: "text", text: String(callCount) }] }),
    }],
  };
}
`,
    );

    const log = makeLogger();
    const r1 = await loadOnePluginFull(pluginDir, makeConfig(), log);
    const r2 = await loadOnePluginFull(pluginDir, makeConfig(), log);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    // Both should load successfully (cache-busting means each import is a fresh module)
    expect(r1!.tools).toHaveLength(1);
    expect(r2!.tools).toHaveLength(1);

    // Call each handler to verify they are independently callable.
    // With true cache-busting (separate module instances), each handler's callCount
    // starts at 0, so both would return "1". With shared modules, the second returns "2".
    // This test documents the observable behavior without asserting isolation guarantees
    // that depend on Node.js internals.
    const res1 = await r1!.tools[0]!.handler({});
    const res2 = await r2!.tools[0]!.handler({});
    expect(["1", "2"]).toContain(res1.content[0]!.text);
    expect(["1", "2"]).toContain(res2.content[0]!.text);
  });

  it("loadPluginsFull returns array of LoadedPlugin objects with all fields populated", async () => {
    const dir1 = path.join(tmpDir, "p1");
    const dir2 = path.join(tmpDir, "p2");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    writePlugin(
      dir1,
      makeManifest({ name: "test/alpha", toolNamePrefix: "alphaPlugin" }),
      validRegisterCode("alphaPluginFoo"),
    );
    writePlugin(
      dir2,
      makeManifest({ name: "test/beta", toolNamePrefix: "betaPlugin" }),
      validRegisterCode("betaPluginBar"),
    );

    const log = makeLogger();
    const results = await loadPluginsFull([dir1, dir2], makeConfig(), log);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.spec).toBeDefined();
      expect(r.pluginDir).toBeDefined();
      expect(r.manifest).toBeDefined();
      expect(r.manifest.name).toBeDefined();
      expect(r.manifest.toolNamePrefix).toBeDefined();
      expect(Array.isArray(r.tools)).toBe(true);
      expect(r.tools.length).toBeGreaterThan(0);
    }
    const names = results.map((r) => r.tools[0]!.schema.name).sort();
    expect(names).toEqual(["alphaPluginFoo", "betaPluginBar"]);
  });

  it("entrypoint path-traversal guard — returns null for ../../etc/passwd", async () => {
    const pluginDir = path.join(tmpDir, "traversal");
    fs.mkdirSync(pluginDir);
    // Write a manifest with an entrypoint that attempts path traversal
    fs.writeFileSync(
      path.join(pluginDir, "claude-ide-bridge-plugin.json"),
      JSON.stringify(makeManifest({ entrypoint: "../../etc/passwd" })),
    );

    const log = makeLogger();
    const result = await loadOnePluginFull(pluginDir, makeConfig(), log);

    // Should be null due to path traversal guard
    expect(result).toBeNull();
  });
});
