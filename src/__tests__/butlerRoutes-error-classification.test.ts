/**
 * The Butler HTTP surface must not hand an unexpected error's text to a
 * client — CodeQL alert #139, `js/stack-trace-exposure` at butlerRoutes.ts:63.
 *
 * Three handlers caught EVERY throw and echoed `err.message` as a 400. The
 * intent, stated in a comment above one of them, was that `remember` throws
 * on caller-fixable input and those are 400s. True, and worth keeping — but
 * the same catch also sees an `appendFileSync` failure whose message carries
 * the full `~/.patchwork/butler/facts.jsonl` path, and sends it to whoever
 * asked.
 *
 * These tests pin both halves, because fixing only the leak would make the
 * API worse: a caller who sends a 20 000-character object deserves to be told
 * that, not "Internal server error".
 *
 * The store errors are faked here rather than provoked for real. Filling a
 * disk or revoking write permission inside a unit test is not portable, and
 * the thing under test is the ROUTE's classification, not the store's ability
 * to fail.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  ButlerNotFoundError,
  ButlerValidationError,
} from "../butler/errors.js";
import type { ButlerRouteDeps } from "../butlerRoutes.js";
import { tryHandleButlerRoute } from "../butlerRoutes.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes() {
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

/** A fact store whose `remember` throws whatever the test supplies. */
function storeThrowing(err: unknown) {
  return {
    remember: () => {
      throw err;
    },
    list: () => [],
    quarantined: () => [],
  } as unknown as ReturnType<ButlerRouteDeps["factStoreFn"]>;
}

/** POST a valid fact body at a store that will throw `err`. */
async function postFact(err: unknown) {
  const req = makeReq("POST");
  const { res, read } = makeRes();
  tryHandleButlerRoute(req, res, new URL("http://x/butler/facts"), {
    factStoreFn: () => storeThrowing(err),
  });
  (req as unknown as EventEmitter).emit(
    "data",
    Buffer.from(
      JSON.stringify({ subject: "user", predicate: "likes", object: "tea" }),
    ),
  );
  (req as unknown as EventEmitter).emit("end");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return read();
}

describe("butlerRoutes error classification", () => {
  it("echoes a validation error as 400 — the caller can fix it", async () => {
    const { status, body } = await postFact(
      new ButlerValidationError("object exceeds 4096 characters"),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe("object exceeds 4096 characters");
  });

  it("echoes a not-found error as 404, not 400", async () => {
    const { status, body } = await postFact(
      new ButlerNotFoundError("no fact with seq 999"),
    );
    expect(status).toBe(404);
    expect(JSON.parse(body).error).toBe("no fact with seq 999");
  });

  it("does NOT echo an unexpected error — this is alert #139", async () => {
    const leak = new Error(
      "EACCES: permission denied, open '/Users/someone/.patchwork/butler/facts.jsonl'",
    );
    const { status, body } = await postFact(leak);
    expect(status).toBe(500);
    // The two things that must never reach a client.
    expect(body).not.toContain(".patchwork");
    expect(body).not.toContain("EACCES");
    expect(JSON.parse(body).error).toBe("Internal server error");
  });

  it("does not echo a non-Error throw either", async () => {
    const { status, body } = await postFact({
      secret: "/Users/someone/.patchwork/tokens",
    });
    expect(status).toBe(500);
    expect(body).not.toContain(".patchwork");
  });
});
