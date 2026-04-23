/**
 * Tests for recipe `servers:` field — on-demand plugin loading before steps run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock pluginLoader before any imports ──────────────────────────────────────

vi.mock("../../pluginLoader.js", () => ({
  loadPluginsFull: vi.fn(),
}));

import { loadPluginsFull } from "../../pluginLoader.js";

const mockLoadPluginsFull = vi.mocked(loadPluginsFull);

import {
  clearRegistry,
  hasTool,
  registerPluginTools,
} from "../toolRegistry.js";
import { loadRecipeServers, runYamlRecipe } from "../yamlRunner.js";

// Reset state between tests
beforeEach(() => {
  // Clear tool registry to avoid cross-test pollution
  clearRegistry();
  // Re-import tools so built-ins are re-registered
  vi.resetModules();
  mockLoadPluginsFull.mockReset();
});

// ── registerPluginTools ───────────────────────────────────────────────────────

describe("registerPluginTools", () => {
  beforeEach(() => clearRegistry());

  it("registers plugin tools and returns count", () => {
    const count = registerPluginTools([
      {
        name: "myPlugin_doThing",
        handler: async () => "result",
        schema: { name: "myPlugin_doThing", description: "test tool" },
      },
    ]);
    expect(count).toBe(1);
    expect(hasTool("myPlugin_doThing")).toBe(true);
  });

  it("skips already-registered tools (built-ins win)", () => {
    registerPluginTools([
      { name: "myPlugin_doThing", handler: async () => "v1", schema: {} },
    ]);
    // Try to register again — should skip, not throw
    const count = registerPluginTools([
      { name: "myPlugin_doThing", handler: async () => "v2", schema: {} },
    ]);
    expect(count).toBe(0);
  });

  it("registers multiple tools and returns correct count", () => {
    const count = registerPluginTools([
      { name: "plug_a", handler: async () => "a", schema: {} },
      { name: "plug_b", handler: async () => "b", schema: {} },
    ]);
    expect(count).toBe(2);
    expect(hasTool("plug_a")).toBe(true);
    expect(hasTool("plug_b")).toBe(true);
  });
});

// ── loadRecipeServers ─────────────────────────────────────────────────────────

describe("loadRecipeServers", () => {
  beforeEach(() => {
    clearRegistry();
    mockLoadPluginsFull.mockReset();
  });

  it("no-ops on empty array", async () => {
    await loadRecipeServers([]);
    expect(mockLoadPluginsFull).not.toHaveBeenCalled();
  });

  it("logs warning and continues when plugin load fails", async () => {
    mockLoadPluginsFull.mockRejectedValueOnce(new Error("plugin not found"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Should not throw
    await expect(
      loadRecipeServers(["./nonexistent-plugin"]),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to load"),
    );
    warnSpy.mockRestore();
  });

  it("registers tools from a mock plugin", async () => {
    const fakeHandler = vi.fn().mockResolvedValue("hello from plugin");
    mockLoadPluginsFull.mockResolvedValueOnce([
      {
        spec: "./fake-plugin",
        pluginDir: "/tmp/fake-plugin",
        manifest: {
          schemaVersion: 1,
          name: "fake",
          entrypoint: "index.js",
          toolNamePrefix: "fake",
        },
        tools: [
          {
            schema: { name: "fake_greet", description: "greet tool" },
            handler: fakeHandler,
          },
        ],
      },
    ]);

    await loadRecipeServers(["./fake-plugin"]);
    expect(hasTool("fake_greet")).toBe(true);
  });

  it("deduplicates: same spec loaded twice only calls loadPluginsFull once", async () => {
    mockLoadPluginsFull.mockResolvedValue([
      {
        spec: "./my-plugin",
        pluginDir: "/tmp/my-plugin",
        manifest: {
          schemaVersion: 1,
          name: "myplugin",
          entrypoint: "index.js",
          toolNamePrefix: "myplugin",
        },
        tools: [
          {
            schema: { name: "myplugin_tool", description: "a tool" },
            handler: async () => "ok",
          },
        ],
      },
    ]);

    await loadRecipeServers(["./my-plugin"]);
    // Call again — spec already in loadedPluginSpecs set, so should skip
    await loadRecipeServers(["./my-plugin"]);
    expect(mockLoadPluginsFull).toHaveBeenCalledTimes(1);
  });
});

// ── runYamlRecipe with servers ────────────────────────────────────────────────

describe("runYamlRecipe servers integration", () => {
  beforeEach(() => {
    clearRegistry();
    mockLoadPluginsFull.mockReset();
  });

  it("runs normally with servers: [] — no plugin loading attempted", async () => {
    const result = await runYamlRecipe(
      {
        name: "empty-servers",
        trigger: { type: "manual" },
        steps: [],
        servers: [],
      },
      { testMode: true },
    );
    expect(mockLoadPluginsFull).not.toHaveBeenCalled();
    expect(result.recipe).toBe("empty-servers");
  });

  it("runs normally with servers omitted", async () => {
    const result = await runYamlRecipe(
      {
        name: "no-servers",
        trigger: { type: "manual" },
        steps: [],
      },
      { testMode: true },
    );
    expect(mockLoadPluginsFull).not.toHaveBeenCalled();
    expect(result.recipe).toBe("no-servers");
  });

  it("recipe continues even when server spec fails to load", async () => {
    mockLoadPluginsFull.mockRejectedValueOnce(new Error("bad plugin"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runYamlRecipe(
      {
        name: "bad-server-recipe",
        trigger: { type: "manual" },
        steps: [],
        servers: ["./broken-plugin"],
      },
      { testMode: true },
    );

    expect(result.recipe).toBe("bad-server-recipe");
    expect(result.errorMessage).toBeUndefined();
    warnSpy.mockRestore();
  });
});
