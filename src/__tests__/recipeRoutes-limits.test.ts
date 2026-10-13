/**
 * HTTP surface of the operator limits (PATCHWORK_MAX_CONCURRENT_RUNS,
 * PATCHWORK_MAX_RECIPES): a refused run is a 429 with a plain message, a
 * refused recipe addition is a 409 — on every route that can add a recipe.
 */

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { type RecipeRouteDeps, tryHandleRecipeRoute } from "../recipeRoutes.js";
import {
  RECIPE_LIMIT_REACHED,
  RUN_LIMIT_REACHED,
  recipeLimitMessage,
  runLimitMessage,
} from "../recipes/runLimits.js";
import { invalidateRecipesCache } from "../recipesHttp.js";
import { Server } from "../server.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

const flush = () => new Promise((r) => setImmediate(r));

async function call(
  method: string,
  route: string,
  deps: Partial<RecipeRouteDeps>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let out = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      out = b ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  const req = makeReq(method);
  tryHandleRecipeRoute(
    req,
    res,
    new URL(`http://x${route}`),
    deps as RecipeRouteDeps,
  );
  if (body !== undefined) {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  }
  for (let i = 0; i < 6; i++) await flush();
  return { status, body: out ? JSON.parse(out) : {} };
}

const runRefused = {
  runRecipeFn: async () => ({
    ok: false,
    error: RUN_LIMIT_REACHED,
    message: runLimitMessage(2),
  }),
  loadRecipeContentFn: () => null,
};

describe("run routes — run_limit_reached", () => {
  it("POST /recipes/:name/run → 429 with the plain message", async () => {
    const r = await call("POST", "/recipes/noisy-recipe/run", runRefused, {});
    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      ok: false,
      error: RUN_LIMIT_REACHED,
      message: "2 runs are already in progress; try again when one finishes",
    });
  });

  it("POST /recipes/run → 429", async () => {
    const r = await call("POST", "/recipes/run", runRefused, {
      name: "noisy-recipe",
    });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(RUN_LIMIT_REACHED);
  });

  it("other run failures keep their existing 400", async () => {
    const r = await call(
      "POST",
      "/recipes/noisy-recipe/run",
      {
        runRecipeFn: async () => ({ ok: false, error: "already_in_flight" }),
        loadRecipeContentFn: () => null,
      },
      {},
    );
    expect(r.status).toBe(400);
  });
});

const limitRefusal = {
  ok: false,
  error: RECIPE_LIMIT_REACHED,
  message: recipeLimitMessage(3),
};

describe("recipe-adding routes — recipe_limit_reached → 409", () => {
  it("PUT /recipes/:name", async () => {
    const r = await call(
      "PUT",
      "/recipes/noisy-recipe",
      { saveRecipeContentFn: () => limitRefusal },
      { content: "name: noisy-recipe\n" },
    );
    expect(r.status).toBe(409);
    expect(r.body).toEqual(limitRefusal);
  });

  it("POST /recipes", async () => {
    const r = await call(
      "POST",
      "/recipes",
      { saveRecipeFn: () => limitRefusal },
      { name: "noisy-recipe" },
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(RECIPE_LIMIT_REACHED);
  });

  it("POST /recipes/:name/duplicate", async () => {
    const r = await call("POST", "/recipes/noisy-recipe/duplicate", {
      duplicateRecipeFn: () => limitRefusal,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(RECIPE_LIMIT_REACHED);
  });
});

describe("POST /recipes/install — recipe_limit_reached", () => {
  const TOKEN = "test-limit-route-token-00000000000000000";
  let server: Server | null = null;
  let home = "";
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    await server?.close();
    server = null;
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    invalidateRecipesCache();
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  it("refuses a new recipe with 409 and writes nothing", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "pw-limit-route-"));
    vi.stubEnv("PATCHWORK_HOME", home);
    vi.stubEnv("PATCHWORK_MAX_RECIPES", "1");
    const recipesDir = path.join(home, "recipes");
    mkdirSync(recipesDir, { recursive: true });
    writeFileSync(
      path.join(recipesDir, "existing.yaml"),
      "name: existing\ntrigger:\n  type: manual\nsteps: []\n",
    );

    const yamlBody = [
      "name: noisy-recipe",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: s1",
      "    tool: file.write",
      "    path: out.txt",
      "    content: y",
      "",
    ].join("\n");
    const enc = new TextEncoder();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(yamlBody));
          c.close();
        },
      }),
    }) as unknown as typeof fetch;

    server = new Server(TOKEN, new Logger(false));
    const port = await server.findAndListen(null);
    const { status, body } = await new Promise<{
      status: number;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: "POST",
          path: "/recipes/install",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data }),
          );
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/noisy-recipe",
        }),
      );
    });

    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: RECIPE_LIMIT_REACHED,
      code: RECIPE_LIMIT_REACHED,
      message: recipeLimitMessage(1),
    });
    expect(existsSync(path.join(recipesDir, "noisy-recipe.json"))).toBe(false);
  });
});

describe("cron tick — run_limit_reached", () => {
  let home = "";
  afterEach(() => {
    vi.unstubAllEnvs();
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  it("is skipped and logged exactly like an already_in_flight refusal", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "pw-limit-cron-"));
    vi.stubEnv("PATCHWORK_HOME", home);
    const recipesDir = path.join(home, "recipes");
    mkdirSync(recipesDir, { recursive: true });
    writeFileSync(
      path.join(recipesDir, "noisy-recipe.yaml"),
      "name: noisy-recipe\ntrigger:\n  type: cron\n  at: '0 9 * * *'\nsteps: []\n",
    );
    const { RecipeOrchestration } = await import("../recipeOrchestration.js");
    const warnings: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => warnings.push(m) };
    const refusals = [
      { ok: false, error: "already_in_flight" },
      {
        ok: false,
        error: RUN_LIMIT_REACHED,
        message: runLimitMessage(1),
      },
    ];
    for (const refusal of refusals) {
      const scheduler = RecipeOrchestration.buildScheduler({
        recipesDir,
        runRecipeFn: async () => refusal,
        enqueue: (() => "t") as never,
        logger,
      });
      scheduler.fireForTest("noisy-recipe");
    }
    await vi.waitFor(() => expect(warnings).toHaveLength(2));
    expect(warnings[0]).toBe(
      '[scheduler] YAML recipe "noisy-recipe" failed: already_in_flight',
    );
    expect(warnings[1]).toBe(
      '[scheduler] YAML recipe "noisy-recipe" failed: run_limit_reached',
    );
  });
});
