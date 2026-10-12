import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { listInstalledRecipes } from "../recipesHttp.js";
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

describe("GET /recipes — schedule", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "patchwork-recipes-schedule-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function steps(): string {
    return "steps:\n  - id: main\n    agent: true\n    prompt: hi\n";
  }

  it("reports the expression the scheduler parses (`at:` and `schedule:`), and omits it for a manual recipe", async () => {
    // Flat YAML using `at:` — the form the scheduler reads first.
    writeFileSync(
      path.join(dir, "morning.yaml"),
      `name: morning\ntrigger:\n  type: cron\n  at: "0 9 * * *"\n${steps()}`,
    );
    // Install-dir recipe using `at:` with an interval.
    mkdirSync(path.join(dir, "poller"));
    writeFileSync(
      path.join(dir, "poller", "recipe.yaml"),
      `name: poller\ntrigger:\n  type: cron\n  at: "@every 5m"\n${steps()}`,
    );
    // Flat JSON using `schedule:`.
    writeFileSync(
      path.join(dir, "nightly.json"),
      JSON.stringify({
        name: "nightly",
        trigger: { type: "cron", schedule: "30 2 * * *" },
        steps: [{ id: "main", agent: true, prompt: "hi" }],
      }),
    );
    writeFileSync(
      path.join(dir, "by-hand.yaml"),
      `name: by-hand\ntrigger:\n  type: manual\n${steps()}`,
    );
    server!.recipesFn = () =>
      listInstalledRecipes(dir, { disabledRecipes: [] }) as unknown as Record<
        string,
        unknown
      >;

    const { status, body } = await getRecipes();
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as Listed;
    const byName = new Map(parsed.recipes.map((r) => [r.name, r]));
    expect(byName.get("morning")?.schedule).toBe("0 9 * * *");
    expect(byName.get("poller")?.schedule).toBe("@every 5m");
    expect(byName.get("nightly")?.schedule).toBe("30 2 * * *");
    const byHand = byName.get("by-hand");
    expect(byHand).toBeDefined();
    expect(Object.hasOwn(byHand as object, "schedule")).toBe(false);
  });
});
