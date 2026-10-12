/**
 * The run routes validate `vars` against the recipe's DECLARED inputs.
 *
 * A `type: text` input admits prose; everything else keeps the allow-list. The
 * route therefore has to know the recipe it is about to run — before this it
 * validated every value against one rule, so prose could never reach a recipe.
 *
 * The body cap is part of the same contract: a text input at its default
 * maximum (16384 chars) of non-ASCII prose is ~48 KB of UTF-8, which the old
 * 32 KB run cap refused before validation ever saw it.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  RECIPE_ROUTE_BODY_CAPS,
  type RecipeRouteDeps,
  tryHandleRecipeRoute,
} from "../recipeRoutes.js";

const RECIPE_YAML = `name: noisy-recipe
trigger:
  type: manual
  inputs:
    - name: materials
      type: text
    - name: topic
steps:
  - agent:
      prompt: "{{topic}}: {{materials}}"
      into: out
`;

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes(): {
  res: ServerResponse;
  read: () => { status: number; body: string };
} {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

const flush = () => new Promise((r) => setImmediate(r));

async function postRun(
  route: string,
  body: unknown,
): Promise<{
  status: number;
  body: string;
  ran: Array<{ name: string; vars?: Record<string, string> }>;
}> {
  const ran: Array<{ name: string; vars?: Record<string, string> }> = [];
  const deps = {
    loadRecipeContentFn: (name: string) =>
      name === "noisy-recipe"
        ? { content: RECIPE_YAML, path: "/r/noisy-recipe.yaml" }
        : null,
    runRecipeFn: async (name: string, vars?: Record<string, string>) => {
      ran.push({ name, vars });
      return { ok: true, taskId: "t1" };
    },
  } as unknown as RecipeRouteDeps;
  const req = makeReq("POST");
  const { res, read } = makeRes();
  tryHandleRecipeRoute(req, res, new URL(`http://x${route}`), deps);
  req.emit("data", Buffer.from(JSON.stringify(body)));
  req.emit("end");
  for (let i = 0; i < 5; i++) await flush();
  return { ...read(), ran };
}

const PROSE =
  'Notes: "we\'ll ship by 30/09" — see ~/drafts/plan.md\nSecond line.';

describe("POST /recipes/:name/run — vars validated by declared type", () => {
  it("forwards prose for a declared text input", async () => {
    const r = await postRun("/recipes/noisy-recipe/run", {
      vars: { materials: PROSE, topic: "planning" },
    });
    expect(r.status).toBe(200);
    expect(r.ran[0]?.vars?.materials).toBe(PROSE);
  });

  it("refuses the same prose for a string input", async () => {
    const r = await postRun("/recipes/noisy-recipe/run", {
      vars: { topic: PROSE },
    });
    expect(r.status).toBe(400);
    expect(r.ran).toEqual([]);
  });

  it("refuses prose when the recipe cannot be resolved (allow-list applies)", async () => {
    const r = await postRun("/recipes/unknown-recipe/run", {
      vars: { materials: PROSE },
    });
    expect(r.status).toBe(400);
  });

  it("POST /recipes/run applies the same rule", async () => {
    const ok = await postRun("/recipes/run", {
      name: "noisy-recipe",
      vars: { materials: PROSE },
    });
    expect(ok.status).toBe(200);
    const bad = await postRun("/recipes/run", {
      name: "noisy-recipe",
      vars: { topic: PROSE },
    });
    expect(bad.status).toBe(400);
  });

  it("a default-max text input of non-ASCII prose fits under the run body cap", async () => {
    const materials = "議事録".repeat(5462).slice(0, 16384);
    expect(materials.length).toBe(16384);
    const bytes = Buffer.byteLength(JSON.stringify({ vars: { materials } }));
    expect(bytes).toBeGreaterThan(32 * 1024);
    expect(bytes).toBeLessThanOrEqual(RECIPE_ROUTE_BODY_CAPS.run);
    const r = await postRun("/recipes/noisy-recipe/run", {
      vars: { materials },
    });
    expect(r.status).toBe(200);
  });

  it("a hard-cap text input fits even when every char JSON-escapes to \\uXXXX", () => {
    // 65536 code units × 6 bytes is the worst case one input can take.
    expect(65536 * 6 + 1024).toBeLessThanOrEqual(RECIPE_ROUTE_BODY_CAPS.run);
  });
});
