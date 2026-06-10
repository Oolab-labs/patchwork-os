/**
 * POST /runs/:seq/cancel — cancels an in-flight recipe run via the run
 * registry. Exercises tryHandleRecipeRoute directly with a fake req/res.
 * (recipe run-cancel MVP)
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RecipeRouteDeps } from "../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../recipeRoutes.js";
import {
  isRunActive,
  registerRun,
  unregisterRun,
} from "../recipes/runRegistry.js";

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

// The cancel branch returns before touching deps, so a bare cast is safe.
const deps = {} as unknown as RecipeRouteDeps;

afterEach(() => {
  for (const seq of [4242, 4243]) unregisterRun(seq);
});

describe("POST /runs/:seq/cancel", () => {
  it("cancels a live run and aborts its controller (200, cancelled:true)", () => {
    const seq = 4242;
    const controller = registerRun(seq);
    const { res, read } = makeRes();

    const handled = tryHandleRecipeRoute(
      makeReq("POST"),
      res,
      new URL(`http://x/runs/${seq}/cancel`),
      deps,
    );

    expect(handled).toBe(true);
    const { status, body } = read();
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ cancelled: true, seq });
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns 404 cancelled:false for a seq that is not running", () => {
    const { res, read } = makeRes();
    const handled = tryHandleRecipeRoute(
      makeReq("POST"),
      res,
      new URL("http://x/runs/999999/cancel"),
      deps,
    );
    expect(handled).toBe(true);
    const { status, body } = read();
    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ cancelled: false, seq: 999999 });
  });

  it("does not match a GET to the cancel route", () => {
    const seq = 4243;
    registerRun(seq);
    const { res } = makeRes();
    const handled = tryHandleRecipeRoute(
      makeReq("GET"),
      res,
      new URL(`http://x/runs/${seq}/cancel`),
      deps,
    );
    // GET /runs/:seq/cancel is not a registered route → not handled here, and
    // the run stays active (not cancelled by a GET).
    expect(handled).toBe(false);
    expect(isRunActive(seq)).toBe(true);
  });
});
