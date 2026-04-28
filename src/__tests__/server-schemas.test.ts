/**
 * Integration tests for GET /schemas/* — serves generated recipe + dry-run
 * plan schemas so YAML-LSP editors can resolve the `$schema` URLs against
 * a running bridge in dev.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-schemas-token-00000000000000";

let server: Server | null = null;
let port = 0;

async function startServer(): Promise<void> {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function get(
  path: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "GET", path },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /schemas/*", () => {
  it("serves the recipe schema", async () => {
    await startServer();
    const { status, body, contentType } = await get("/schemas/recipe.v1.json");
    expect(status).toBe(200);
    expect(contentType).toContain("application/schema+json");
    const parsed = JSON.parse(body);
    expect(parsed.$id).toBe(
      "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json",
    );
  });

  it("serves the dry-run plan schema", async () => {
    await startServer();
    const { status, body } = await get("/schemas/dry-run-plan.v1.json");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.$id).toBe(
      "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/dry-run-plan.v1.json",
    );
    expect(parsed.properties.schemaVersion.const).toBe(1);
  });

  it("serves a per-namespace tool schema", async () => {
    await startServer();
    const { status, body } = await get("/schemas/tools/file.json");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.$id).toBe(
      "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/tools/file.json",
    );
  });

  it("returns an index at /schemas/", async () => {
    await startServer();
    const { status, body } = await get("/schemas/");
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.recipe).toBe("/schemas/recipe.v1.json");
    expect(parsed.dryRunPlan).toBe("/schemas/dry-run-plan.v1.json");
    expect(Array.isArray(parsed.tools)).toBe(true);
  });

  it("returns 404 for unknown schema names", async () => {
    await startServer();
    const { status } = await get("/schemas/nonexistent.json");
    expect(status).toBe(404);
  });
});
