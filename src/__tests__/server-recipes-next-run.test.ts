import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

/**
 * GET /recipes carries `nextRunAt` (epoch ms) for a recipe the scheduler has
 * a next fire time for, and omits the field otherwise — never 0, never a
 * guess.
 */

const logger = new Logger(false);
const TOKEN = "test-next-run-token-000000000000000000000";

let server: Server | null = null;
let port = 0;

function getRecipes(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: "/recipes",
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
  server.recipesFn = () => ({
    recipesDir: "recipes",
    recipes: [
      { name: "morning", trigger: "cron", schedule: "0 9 * * *" },
      { name: "by-hand", trigger: "manual" },
    ],
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

type Listed = { recipes: Array<Record<string, unknown>> };

describe("GET /recipes — nextRunAt", () => {
  it("includes nextRunAt for a scheduled recipe and omits it for a manual one", async () => {
    const at = Date.parse("2026-10-12T06:00:00.000Z");
    server!.nextRunTimesFn = () => new Map([["morning", at]]);

    const { status, body } = await getRecipes();
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as Listed;
    const morning = parsed.recipes.find((r) => r.name === "morning");
    const byHand = parsed.recipes.find((r) => r.name === "by-hand");
    expect(morning?.nextRunAt).toBe(at);
    expect(byHand).toBeDefined();
    expect(Object.hasOwn(byHand as object, "nextRunAt")).toBe(false);
  });

  it("omits nextRunAt everywhere when no scheduler is wired", async () => {
    const { status, body } = await getRecipes();
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as Listed;
    expect(parsed.recipes).toHaveLength(2);
    for (const r of parsed.recipes) {
      expect(Object.hasOwn(r, "nextRunAt")).toBe(false);
    }
  });

  it("still lists recipes when the next-run lookup throws", async () => {
    server!.nextRunTimesFn = () => {
      throw new Error("boom");
    };
    const { status, body } = await getRecipes();
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as Listed;
    expect(parsed.recipes).toHaveLength(2);
    for (const r of parsed.recipes) {
      expect(Object.hasOwn(r, "nextRunAt")).toBe(false);
    }
  });
});
