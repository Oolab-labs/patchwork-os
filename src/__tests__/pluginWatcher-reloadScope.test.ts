/**
 * A plugin hot reload replaces that plugin's tools and nothing else
 * (audit M37, 2026-10-15).
 *
 * Reload used to clear the old version with
 * `transport.deregisterToolsByPrefix(manifest.toolNamePrefix)`, which removes
 * EVERY tool whose name starts with the prefix. The loader only checks that a
 * plugin's tool NAMES do not collide; it does not stop a prefix from being the
 * start of other tools' names. So a plugin with prefix `get` (legal: 2-20
 * chars) and a tool `getWeather` loads fine — and its first reload deleted
 * `getDiagnostics`, `getBufferContent` and every other `get*` tool from every
 * live session, and any other plugin's tools under the same prefix.
 *
 * A real McpTransport, so what is checked is what a session can call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import type { LoadedPlugin } from "../pluginLoader.js";
import { PluginWatcher } from "../pluginWatcher.js";
import { McpTransport } from "../transport.js";
import { makeConfig } from "./helpers/fixtures.js";

vi.mock("../pluginLoader.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../pluginLoader.js")>();
  return { ...orig, loadOnePluginFull: vi.fn() };
});

import { loadOnePluginFull } from "../pluginLoader.js";

const handler = async () => ({ content: [{ type: "text", text: "ok" }] });

function tool(name: string) {
  return {
    schema: {
      name,
      description: "t",
      inputSchema: { type: "object" as const, properties: {} },
    },
    handler,
  };
}

function plugin(
  spec: string,
  dir: string,
  prefix: string,
  names: string[],
): LoadedPlugin {
  return {
    spec,
    pluginDir: dir,
    manifest: {
      schemaVersion: 1,
      name: `example/${spec}`,
      version: "1.0.0",
      entrypoint: "./index.mjs",
      toolNamePrefix: prefix,
    } as LoadedPlugin["manifest"],
    tools: names.map(tool),
  };
}

function names(t: McpTransport): string[] {
  return [
    ...(t as unknown as { tools: Map<string, unknown> }).tools.keys(),
  ].sort();
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-reload-scope-"));
  vi.spyOn(fs, "watch").mockReturnValue({
    close: vi.fn(),
  } as unknown as fs.FSWatcher);
  vi.mocked(loadOnePluginFull).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const transport = new McpTransport(new Logger(false));
  // Built-ins sharing the prefix, and a second plugin's tool under it too.
  transport.registerTool(tool("getDiagnostics").schema, handler);
  transport.registerTool(tool("getBufferContent").schema, handler);
  const other = plugin("./other", path.join(dir, "o"), "getX", ["getXThing"]);
  const mine = plugin("./mine", dir, "get", ["getWeather"]);
  for (const p of [other, mine])
    for (const t of p.tools) transport.registerTool(t.schema, t.handler);
  const watcher = new PluginWatcher(
    makeConfig({ workspace: dir }),
    new Logger(false),
    vi.fn(),
  );
  watcher.start([other, mine]);
  watcher.addTransport(transport);
  return { transport, watcher };
}

describe("plugin hot reload is scoped to the plugin's own tools", () => {
  it("a reload does not remove other tools that share the prefix", async () => {
    const { transport, watcher } = setup();
    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(
      plugin("./mine", dir, "get", ["getWeather", "getForecast"]),
    );
    await watcher.reloadPlugin("./mine");
    expect(names(transport)).toEqual([
      "getBufferContent",
      "getDiagnostics",
      "getForecast",
      "getWeather",
      "getXThing",
    ]);
    watcher.stop();
  });

  it("a tool dropped by the new version is removed", async () => {
    const { transport, watcher } = setup();
    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(
      plugin("./mine", dir, "get", ["getForecast"]),
    );
    await watcher.reloadPlugin("./mine");
    expect(names(transport)).not.toContain("getWeather");
    expect(names(transport)).toContain("getForecast");
    watcher.stop();
  });

  it("a failed apply restores the old tools and leaves the others alone", async () => {
    const { transport, watcher } = setup();
    vi.mocked(loadOnePluginFull).mockResolvedValueOnce(
      plugin("./mine", dir, "get", ["getForecast"]),
    );
    const real = transport.replaceTool.bind(transport);
    vi.spyOn(transport, "replaceTool").mockImplementation((s, h, t) => {
      if (s.name === "getForecast") throw new Error("boom");
      real(s, h, t);
    });
    await watcher.reloadPlugin("./mine");
    expect(names(transport)).toEqual([
      "getBufferContent",
      "getDiagnostics",
      "getWeather",
      "getXThing",
    ]);
    watcher.stop();
  });
});
