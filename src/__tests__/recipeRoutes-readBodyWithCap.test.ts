/**
 * Unit tests for `readBodyWithCap` — the byte-collection layer that
 * `readJsonBody` is now built on top of and that connector routes use
 * directly. Existing rate-limit / install tests cover `readJsonBody`'s
 * behavior end-to-end through an HTTP server; these tests exercise
 * `readBodyWithCap` directly with a fake IncomingMessage.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readBodyWithCap } from "../recipeRoutes.js";

class FakeReq extends EventEmitter {
  resume(): this {
    return this;
  }
}

function feed(req: FakeReq, chunks: Buffer[], emitEnd = true): void {
  // Defer emission so the helper has a chance to attach listeners.
  queueMicrotask(() => {
    for (const c of chunks) req.emit("data", c);
    if (emitEnd) req.emit("end");
  });
}

describe("readBodyWithCap", () => {
  it("returns the full body when under the cap", async () => {
    const req = new FakeReq();
    const promise = readBodyWithCap(req as unknown as IncomingMessage, 1024);
    feed(req, [Buffer.from("hello world", "utf-8")]);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("hello world");
  });

  it("returns too_large the moment cumulative bytes exceed the cap", async () => {
    const req = new FakeReq();
    const promise = readBodyWithCap(req as unknown as IncomingMessage, 4);
    // Two chunks: 3 bytes + 3 bytes = 6 total, exceeds 4.
    feed(req, [Buffer.from("abc"), Buffer.from("def")]);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_large");
  });

  it("rejects on the first overflowing chunk (not after full body lands)", async () => {
    const req = new FakeReq();
    const promise = readBodyWithCap(req as unknown as IncomingMessage, 4);
    // Single 8-byte chunk should overflow; resolve before `end`.
    feed(req, [Buffer.from("12345678")], /* emitEnd */ false);
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it("returns empty body when the request emits no data chunks", async () => {
    const req = new FakeReq();
    const promise = readBodyWithCap(req as unknown as IncomingMessage, 1024);
    feed(req, []);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("");
  });

  it("treats stream errors as too_large (collapsed to one error path)", async () => {
    const req = new FakeReq();
    const promise = readBodyWithCap(req as unknown as IncomingMessage, 1024);
    queueMicrotask(() => req.emit("error", new Error("ECONNRESET")));
    const result = await promise;
    expect(result.ok).toBe(false);
  });
});
