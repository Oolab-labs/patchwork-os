/**
 * Tests for `GET /recipes/doctor?recipe=<name>` — the server-side home
 * for the `recipe doctor` CLI. The composition itself (lint + policy +
 * halts) is covered by commands/__tests__/recipeDoctor.test.ts; these
 * tests assert the HTTP endpoint's query parsing, name-only guard, and
 * error mapping, plus one happy path against a bundled recipe.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-recipes-doctor-token-0000000000000";

let server: Server | null = null;
let port = 0;

function makeRequest(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
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
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

describe("GET /recipes/doctor", () => {
  it("400 missing_recipe when ?recipe= is absent", async () => {
    const { status, body } = await makeRequest("/recipes/doctor");
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe("missing_recipe");
  });

  it("400 invalid_recipe when the ref contains a path separator", async () => {
    const { status, body } = await makeRequest(
      `/recipes/doctor?recipe=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe("invalid_recipe");
  });

  it("404 recipe_not_found for an unknown bare name", async () => {
    const { status, body } = await makeRequest(
      "/recipes/doctor?recipe=definitely-not-a-real-recipe-xyz",
    );
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toBe("recipe_not_found");
  });

  it("200 with a diagnosis for a bundled recipe", async () => {
    const { status, body } = await makeRequest(
      "/recipes/doctor?recipe=daily-status",
    );
    expect(status).toBe(200);
    const result = JSON.parse(body);
    expect(result.recipe).toBe("daily-status");
    expect(result.static).toBeDefined();
    expect(Array.isArray(result.static.issues)).toBe(true);
    // runtime is the in-process halt summary (object) or null — never undefined.
    expect(result.runtime === null || typeof result.runtime === "object").toBe(
      true,
    );
    expect(typeof result.ok).toBe("boolean");
  });
});
