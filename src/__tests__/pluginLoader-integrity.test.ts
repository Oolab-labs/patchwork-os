/**
 * `loadPluginsFull` verifies an allowlist integrity pin against the REAL
 * entrypoint bytes before importing them.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { loadPluginsFull } from "../pluginLoader.js";

const config = {
  workspace: process.cwd(),
  workspaceFolders: [process.cwd()],
  commandTimeout: 30_000,
  maxResultSize: 1_048_576,
} as unknown as Config;

function makeLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    debug: () => {},
  } as unknown as Logger & { warns: string[] };
}

const REGISTER = `export function register() {
  return { tools: [{ schema: { name: "integ_hello", description: "t",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    handler: async () => ({ content: [] }) }] };
}
`;

describe("loadPluginsFull integrity", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-integ-"));
    fs.writeFileSync(
      path.join(dir, "claude-ide-bridge-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "integ/plugin",
        version: "1.0.0",
        entrypoint: "./index.mjs",
        toolNamePrefix: "integ",
      }),
    );
    fs.writeFileSync(path.join(dir, "index.mjs"), REGISTER);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hash = () =>
    `sha256-${createHash("sha256")
      .update(fs.readFileSync(path.join(dir, "index.mjs")))
      .digest("base64")}`;

  it("matching pin loads the plugin", async () => {
    const loaded = await loadPluginsFull([dir], config, makeLogger(), {
      integrity: hash(),
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.tools[0]?.schema.name).toBe("integ_hello");
  });

  it("mismatching pin throws plugin_integrity_mismatch before import", async () => {
    const pin = hash();
    fs.appendFileSync(path.join(dir, "index.mjs"), "\n// tampered\n");
    await expect(
      loadPluginsFull([dir], config, makeLogger(), { integrity: pin }),
    ).rejects.toMatchObject({ code: "plugin_integrity_mismatch" });
  });

  it("no pin loads without checking", async () => {
    const loaded = await loadPluginsFull([dir], config, makeLogger(), {});
    expect(loaded).toHaveLength(1);
  });
});
