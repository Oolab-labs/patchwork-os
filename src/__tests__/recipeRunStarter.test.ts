/**
 * "Run now" records who started the run (ADR-0020 separation of duties).
 *
 * The route reads the session the dashboard forwards as `x-patchwork-session`
 * and VERIFIES it through `resolveRunStarter`. Only a verified human member
 * becomes `startedBy`. Everything else — no header, an unnamed session, a
 * worker, a resolver that throws — starts the run exactly as before, with no
 * attempt object, because a failed lookup must never stop a run.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { type RecipeRouteDeps, tryHandleRecipeRoute } from "../recipeRoutes.js";

const RECIPE_YAML = `name: example-recipe
trigger:
  type: manual
steps:
  - agent:
      prompt: "hello"
      into: out
`;

const flush = () => new Promise((r) => setImmediate(r));

async function postRun(
  route: string,
  headers: Record<string, string>,
  resolveRunStarter?: RecipeRouteDeps["resolveRunStarter"],
) {
  const attempts: unknown[] = [];
  const deps = {
    loadRecipeContentFn: (name: string) =>
      name === "example-recipe"
        ? { content: RECIPE_YAML, path: "/r/example-recipe.yaml" }
        : null,
    runRecipeFn: async (
      _name: string,
      _vars?: Record<string, string>,
      attempt?: unknown,
    ) => {
      attempts.push(attempt);
      return { ok: true, taskId: "t1" };
    },
    resolveRunStarter,
  } as unknown as RecipeRouteDeps;
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  (req as { headers?: Record<string, string> }).headers = headers;
  let status = 0;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  tryHandleRecipeRoute(req, res, new URL(`http://x${route}`), deps);
  req.emit("data", Buffer.from("{}"));
  req.emit("end");
  for (let i = 0; i < 5; i++) await flush();
  return { status, attempts };
}

const human = async () => ({ id: "ada", kind: "human" });

describe("POST /recipes/:name/run records the verified starter", () => {
  it("passes startedBy for a verified human member", async () => {
    const r = await postRun(
      "/recipes/example-recipe/run",
      { "x-patchwork-session": "v2.ada.1.sig" },
      human,
    );
    expect(r.status).toBe(200);
    expect(r.attempts).toEqual([{ startedBy: "ada" }]);
  });

  it("passes nothing with no session header", async () => {
    const r = await postRun("/recipes/example-recipe/run", {}, human);
    expect(r.attempts).toEqual([undefined]);
  });

  it("passes nothing when the session names nobody", async () => {
    const r = await postRun(
      "/recipes/example-recipe/run",
      { "x-patchwork-session": "v1.1.sig" },
      async () => undefined,
    );
    expect(r.attempts).toEqual([undefined]);
  });

  it("passes nothing for a worker identity", async () => {
    const r = await postRun(
      "/recipes/example-recipe/run",
      { "x-patchwork-session": "v2.w.1.sig" },
      async () => ({ id: "w", kind: "worker" }),
    );
    expect(r.attempts).toEqual([undefined]);
  });

  it("still starts the run when the resolver throws", async () => {
    const r = await postRun(
      "/recipes/example-recipe/run",
      { "x-patchwork-session": "v2.ada.1.sig" },
      async () => {
        throw new Error("boom");
      },
    );
    expect(r.status).toBe(200);
    expect(r.attempts).toEqual([undefined]);
  });

  it("passes nothing when no resolver is wired (no session secret)", async () => {
    const r = await postRun("/recipes/example-recipe/run", {
      "x-patchwork-session": "v2.ada.1.sig",
    });
    expect(r.attempts).toEqual([undefined]);
  });
});
