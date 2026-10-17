/**
 * Plugin tool descriptions get the same 200-character cap as built-in tools
 * (audit M37, 2026-10-15).
 *
 * `tools/list` goes out on every request, so a built-in description over 200
 * characters fails CI (`scripts/audit-lsp-tools.mjs`, check 6). That audit
 * reads source in this repository; a plugin is loaded at runtime and never
 * passes through it, so a plugin could put any amount of text into every
 * session's tool list. The loader now truncates and says so, rather than
 * rejecting: refusing a working plugin over its prose would be a breaking
 * change for every plugin already published.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins, PLUGIN_DESCRIPTION_MAX } from "../pluginLoader.js";
import { makeConfig } from "./helpers/fixtures.js";

function makeLogger() {
  const warns: string[] = [];
  const noop = () => {};
  const logger = {
    warns,
    info: noop,
    warn: (m: string) => warns.push(m),
    error: noop,
    debug: noop,
    event: noop,
    child: () => logger,
  };
  return logger as unknown as import("../logger.js").Logger & {
    warns: string[];
  };
}

function writePlugin(dir: string, description: string) {
  fs.writeFileSync(
    path.join(dir, "claude-ide-bridge-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "example/long-description",
      version: "1.0.0",
      entrypoint: "./index.mjs",
      toolNamePrefix: "examplePlugin",
    }),
  );
  fs.writeFileSync(
    path.join(dir, "index.mjs"),
    `export function register() {
  return { tools: [{
    schema: {
      name: "examplePluginTool",
      description: ${JSON.stringify(description)},
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }] };
}
`,
  );
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-desc-cap-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin tool description cap", () => {
  it("is the same cap as built-in tools", () => {
    expect(PLUGIN_DESCRIPTION_MAX).toBe(200);
  });

  it("a description over the cap is truncated to it, with a warning naming the tool", async () => {
    writePlugin(dir, "x".repeat(5_000));
    const log = makeLogger();
    const tools = await loadPlugins([dir], makeConfig({ workspace: dir }), log);
    expect(tools).toHaveLength(1);
    const d = tools[0]?.schema.description ?? "";
    expect(d.length).toBeLessThanOrEqual(PLUGIN_DESCRIPTION_MAX);
    expect(d.endsWith("…")).toBe(true);
    expect(log.warns.some((w) => w.includes("examplePluginTool"))).toBe(true);
    expect(log.warns.some((w) => w.includes("5000"))).toBe(true);
  });

  it("a description within the cap is untouched and not warned about", async () => {
    writePlugin(dir, "Short and clear.");
    const log = makeLogger();
    const tools = await loadPlugins([dir], makeConfig({ workspace: dir }), log);
    expect(tools[0]?.schema.description).toBe("Short and clear.");
    expect(log.warns.some((w) => w.includes("description"))).toBe(false);
  });
});
