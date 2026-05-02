import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { listInstalledRecipes } from "../recipesHttp.js";
import { Server } from "../server.js";

/**
 * Regression guard for recipe-dogfood-2026-05-01 A-PR4: GET /recipes
 * response items must NOT carry the `hasPermissions` field. The dashboard
 * already treats missing field as `false`, and the on-disk sidecar has
 * been deleted.
 */

const logger = new Logger(false);
const TOKEN = "test-no-perms-field-token-00000000000000";

let server: Server | null = null;
let port = 0;
let recipesDir: string;

function makeRequest(
  options: http.RequestOptions,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  recipesDir = mkdtempSync(path.join(tmpdir(), "patchwork-no-perms-field-"));
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  rmSync(recipesDir, { recursive: true, force: true });
});

describe("GET /recipes — no hasPermissions field (A-PR4)", () => {
  it("listInstalledRecipes does not include hasPermissions on disk-loaded summaries", () => {
    const recipe = {
      name: "alpha-recipe",
      version: "1.0",
      trigger: { type: "manual" },
      steps: [{ id: "x", agent: false, tool: "send_message", params: {} }],
    };
    writeFileSync(
      path.join(recipesDir, "alpha-recipe.json"),
      JSON.stringify(recipe),
    );
    // Even if a stale sidecar still exists on disk (legacy install pre-alpha.36),
    // the field must not surface in the response shape.
    writeFileSync(
      path.join(recipesDir, "alpha-recipe.json.permissions.json"),
      JSON.stringify({ permissions: { allow: [], ask: [], deny: [] } }),
    );

    const result = listInstalledRecipes(recipesDir);

    expect(result.recipes).toHaveLength(1);
    const summary = result.recipes[0];
    expect(summary.name).toBe("alpha-recipe");
    expect(Object.hasOwn(summary, "hasPermissions")).toBe(false);
  });

  it("GET /recipes response items do not carry hasPermissions", async () => {
    server!.recipesFn = () =>
      listInstalledRecipes(recipesDir) as unknown as Record<string, unknown>;

    const recipe = {
      name: "beta-recipe",
      version: "1.0",
      trigger: { type: "manual" },
      steps: [{ id: "x", agent: false, tool: "send_message", params: {} }],
    };
    writeFileSync(
      path.join(recipesDir, "beta-recipe.json"),
      JSON.stringify(recipe),
    );

    const { status, body } = await makeRequest({
      method: "GET",
      path: "/recipes",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body) as {
      recipes: Array<Record<string, unknown>>;
    };
    expect(parsed.recipes.length).toBeGreaterThan(0);
    for (const r of parsed.recipes) {
      expect(Object.hasOwn(r, "hasPermissions")).toBe(false);
    }
  });
});
