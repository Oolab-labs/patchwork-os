/**
 * POST /outcomes — a store failure is not a bad request.
 *
 * The route wrapped `store.upsert()` in a catch that answered EVERY error with
 * `400` and the error's raw `message`. `upsert` throws a TYPED
 * `AmbiguousActionRefError` for the validation case it means to report; every
 * other error escaping it comes from `appendFileSync` on
 * `outcome-log.jsonl`. So a disk fault (EACCES / ENOSPC / a read-only volume)
 * was reported to the operator as "your request is malformed", carrying the
 * filesystem path in the body.
 *
 * Two defects in one catch:
 *
 *  1. CORRECTNESS, and the reason this matters more than its severity label.
 *     The operator's confirmation is the ONLY thing that moves a worker's
 *     dial on a non-reversible action — an unconfirmed filing is withheld
 *     forever. Telling that operator their input was invalid, when the write
 *     actually failed, sends them to fix a request that was already correct
 *     while the disposition is silently lost. A 500 says "retry"; a 400 says
 *     "stop, you are wrong".
 *
 *  2. DISCLOSURE (CodeQL js/stack-trace-exposure, alert #141). An arbitrary
 *     Error message from inside the store is echoed to an HTTP caller.
 *
 * The fix classifies at the SOURCE's own signal — `instanceof
 * AmbiguousActionRefError` — rather than sniffing message text. This codebase
 * has corrected the string-matching version of this mistake twice (#1349,
 * #1356); enumerating error spellings is how a new spelling gets missed.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { RecipeRouteDeps } from "../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../recipeRoutes.js";
import { AmbiguousActionRefError } from "../workers/actionRef.js";
import type { OutcomeStore } from "../workers/outcomeStore.js";

function makeReq(): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
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

/** A store whose `upsert` fails the way the caller under test chooses. */
function depsWithFailingUpsert(err: Error): RecipeRouteDeps {
  return {
    outcomeStoreFn: () =>
      ({
        upsert() {
          throw err;
        },
        readAll: () => [],
        getDisposition: () => null,
      }) as unknown as OutcomeStore,
  } as unknown as RecipeRouteDeps;
}

async function post(
  deps: RecipeRouteDeps,
): Promise<{ status: number; body: string }> {
  const req = makeReq();
  const { res, read } = makeRes();
  tryHandleRecipeRoute(req, res, new URL("http://x/outcomes"), deps);
  req.emit(
    "data",
    Buffer.from(
      JSON.stringify({
        issueUrl: "https://github.com/o/r/issues/1",
        disposition: "confirmed",
      }),
    ),
  );
  req.emit("end");
  await flush();
  await flush();
  return read();
}

describe("POST /outcomes — store failures are classified by type, not echoed", () => {
  it("a disk failure is a 500 and does not leak the error message", async () => {
    // The shape appendFileSync actually throws: message carries the path.
    const diskErr = Object.assign(
      new Error(
        "EACCES: permission denied, open '/Users/someone/.patchwork/outcome-log.jsonl'",
      ),
      { code: "EACCES" },
    );

    const { status, body } = await post(depsWithFailingUpsert(diskErr));

    expect(status, "a failed write is a server fault, not a bad request").toBe(
      500,
    );
    expect(body).not.toContain("EACCES");
    expect(body).not.toContain("outcome-log.jsonl");
    expect(body).not.toContain(".patchwork");
  });

  it("a validation refusal is still a 400 with its authored message", async () => {
    // The one error the route MEANS to surface. Its text is written by us for
    // an operator to read, so it must survive the fix intact — a change that
    // hid this too would be a regression wearing a security fix's clothes.
    const authored =
      "An outcome record needs a usable key — either `issueUrl` or a `ref` with a tool and an id.";

    const { status, body } = await post(
      depsWithFailingUpsert(new AmbiguousActionRefError(authored)),
    );

    expect(status).toBe(400);
    expect(body).toContain("usable key");
  });
});
