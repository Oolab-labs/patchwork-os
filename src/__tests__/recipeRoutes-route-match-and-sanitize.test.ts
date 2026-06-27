/**
 * Audit 2026-06-10 cluster C7 regression tests for src/recipeRoutes.ts.
 *
 * http-routes-1 — GET/POST /recipes must match against parsedUrl.pathname,
 *   not req.url, so a query string (`/recipes?sort=name`) still routes to the
 *   recipe list / create handler instead of falling through to a 404.
 * http-routes-2 — POST /recipes/:name/duplicate must run its error through
 *   sanitizeStorageError() like the sibling delete/archive handlers, so a raw
 *   ENOENT filesystem path is never leaked in the response body.
 *
 * These exercise `tryHandleRecipeRoute` directly with a fake req/res rather
 * than spinning up a full Server.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { type RecipeRouteDeps, tryHandleRecipeRoute } from "../recipeRoutes.js";

/** Minimal req stub — a readable-ish EventEmitter with method/url. */
function makeReq(method: string, url: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  return req;
}

interface CapturedRes {
  res: ServerResponse;
  done: Promise<{ status: number; body: string }>;
}

/** Capture writeHead status + the body passed to res.end(). */
function makeRes(): CapturedRes {
  let status = 0;
  let resolveDone!: (v: { status: number; body: string }) => void;
  const done = new Promise<{ status: number; body: string }>((r) => {
    resolveDone = r;
  });
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(body?: string) {
      resolveDone({ status, body: body ?? "" });
      return this;
    },
  } as unknown as ServerResponse;
  return { res, done };
}

/** All-null deps with selected overrides applied. */
function makeDeps(overrides: Partial<RecipeRouteDeps>): RecipeRouteDeps {
  const base = {
    setRecipeTrustFn: null,
    generateRecipeFn: null,
    repairRecipeFn: null,
    recipesFn: null,
    loadRecipeContentFn: null,
    saveRecipeContentFn: null,
    deleteRecipeContentFn: null,
    archiveRecipeFn: null,
    duplicateRecipeFn: null,
    promoteRecipeVariantFn: null,
    lintRecipeContentFn: null,
    saveRecipeFn: null,
    setRecipeEnabledFn: null,
    runsFn: null,
    runDetailFn: null,
    haltSummaryFn: null,
    judgeSummaryFn: null,
    runPlanFn: null,
    simulateFn: null,
    workerShadowFn: null,
    runReplayFn: null,
    runRecipeFn: null,
    onRecipesChangedFn: null,
  } as unknown as RecipeRouteDeps;
  return { ...base, ...overrides };
}

describe("http-routes-1 — GET /recipes matches pathname, not req.url", () => {
  it("routes GET /recipes?sort=name to the list handler (not 404)", async () => {
    let called = false;
    const deps = makeDeps({
      recipesFn: () => {
        called = true;
        return { recipesDir: null, recipes: [] };
      },
    });
    const req = makeReq("GET", "/recipes?sort=name");
    const { res, done } = makeRes();

    const handled = tryHandleRecipeRoute(
      req,
      res,
      new URL("http://x/recipes?sort=name"),
      deps,
    );

    expect(handled).toBe(true);
    const { status, body } = await done;
    expect(called).toBe(true);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ recipesDir: null, recipes: [] });
  });

  it("still routes bare GET /recipes (no query string)", async () => {
    const deps = makeDeps({
      recipesFn: () => ({ recipesDir: "/r", recipes: [] }),
    });
    const req = makeReq("GET", "/recipes");
    const { res, done } = makeRes();

    const handled = tryHandleRecipeRoute(
      req,
      res,
      new URL("http://x/recipes"),
      deps,
    );

    expect(handled).toBe(true);
    expect((await done).status).toBe(200);
  });
});

describe("http-routes-2 — POST /recipes/:name/duplicate sanitizes storage error", () => {
  it("collapses a raw ENOENT path to 'Storage error' in the body", async () => {
    const leakyPath =
      "ENOENT: no such file or directory, open '/home/user/.patchwork/recipes/foo.yaml'";
    const deps = makeDeps({
      duplicateRecipeFn: () => ({ ok: false, error: leakyPath }),
    });
    const req = makeReq("POST", "/recipes/foo/duplicate");
    const { res, done } = makeRes();

    const handled = tryHandleRecipeRoute(
      req,
      res,
      new URL("http://x/recipes/foo/duplicate"),
      deps,
    );

    expect(handled).toBe(true);
    const { body } = await done;
    expect(body).not.toContain("/home/user/.patchwork");
    expect(body).not.toContain("ENOENT");
    expect(JSON.parse(body).error).toBe("Storage error");
  });

  it("passes a non-filesystem error through unchanged", async () => {
    const deps = makeDeps({
      duplicateRecipeFn: () => ({ ok: false, error: "Recipe not found" }),
    });
    const req = makeReq("POST", "/recipes/missing/duplicate");
    const { res, done } = makeRes();

    tryHandleRecipeRoute(
      req,
      res,
      new URL("http://x/recipes/missing/duplicate"),
      deps,
    );

    const { status, body } = await done;
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toBe("Recipe not found");
  });
});
