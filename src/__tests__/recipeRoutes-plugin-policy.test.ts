import os from "node:os";
/**
 * Plugin policy at the HTTP write boundary: `/recipes/install` and
 * `PUT /recipes/:name` refuse a recipe naming a non-allowlisted `servers:`
 * spec under the governed profile (400 `plugin_not_allowlisted`); compat is
 * unchanged.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../governance/profile.js";
import { Logger } from "../logger.js";
import { clearConfigCache, defaultConfigPath } from "../patchworkConfig.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-plugin-policy-token-000000000000000";

let server: Server | null = null;
let port = 0;
const originalFetch = globalThis.fetch;

function request(
  options: http.RequestOptions,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function fakeResponse(status: number, body: string) {
  const enc = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    body: new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(body));
        c.close();
      },
    }),
  };
}

function writeConfig(cfg: Record<string, unknown>): void {
  const p = defaultConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg));
  clearConfigCache();
}

const YAML_WITH_SERVERS = [
  "name: plugin-policy-fixture",
  "version: 1.0.0",
  "servers:",
  "  - ./nope-plugin",
  "trigger:",
  "  type: manual",
  "steps:",
  "  - id: s1",
  "    tool: file.write",
  "    params:",
  `      path: ${path.join(os.tmpdir(), "x")}`,
  "      content: y",
  "",
].join("\n");

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
  writeConfig({ profile: "governed", plugins: { allow: [] } });
});

afterEach(async () => {
  await server?.close();
  server = null;
  globalThis.fetch = originalFetch;
  _resetActiveProfileForTesting();
  try {
    fs.unlinkSync(defaultConfigPath());
  } catch {
    /* absent */
  }
  clearConfigCache();
});

describe("plugin policy — /recipes/install", () => {
  it("governed: non-allowlisted servers ⇒ 400 plugin_not_allowlisted, nothing written", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(200, YAML_WITH_SERVERS),
      ) as unknown as typeof fetch;
    const onChange = vi.fn();
    server!.onRecipesChangedFn = onChange;
    const { status, body } = await request(
      { method: "POST", path: "/recipes/install", headers },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/plugin-policy-fixture",
      }),
    );
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("plugin_not_allowlisted");
    expect(parsed.specs).toEqual(["./nope-plugin"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("governed + allowlisted ⇒ install proceeds past the policy gate", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    writeConfig({
      profile: "governed",
      plugins: { allow: [{ spec: "./nope-plugin" }] },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(200, YAML_WITH_SERVERS),
      ) as unknown as typeof fetch;
    const { status, body } = await request(
      { method: "POST", path: "/recipes/install", headers },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/plugin-policy-fixture",
      }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
  });

  it("compat: unchanged — the same recipe installs", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(200, YAML_WITH_SERVERS),
      ) as unknown as typeof fetch;
    const { status } = await request(
      { method: "POST", path: "/recipes/install", headers },
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/plugin-policy-fixture",
      }),
    );
    expect(status).toBe(200);
  });
});

describe("plugin policy — PUT /recipes/:name", () => {
  it("governed: refused before saveRecipeContentFn runs", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const save = vi.fn(() => ({ ok: true, path: "/x" }));
    server!.saveRecipeContentFn = save;
    const { status, body } = await request(
      { method: "PUT", path: "/recipes/plugin-policy-fixture", headers },
      JSON.stringify({ content: YAML_WITH_SERVERS }),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      error: "plugin_not_allowlisted",
      specs: ["./nope-plugin"],
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("compat: save proceeds", async () => {
    const save = vi.fn(() => ({ ok: true, path: "/x" }));
    server!.saveRecipeContentFn = save;
    const { status } = await request(
      { method: "PUT", path: "/recipes/plugin-policy-fixture", headers },
      JSON.stringify({ content: YAML_WITH_SERVERS }),
    );
    expect(status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
