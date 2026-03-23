/**
 * Unit tests for httpProbe.pingBridge.
 *
 * We mock `node:http` so no real network connections are made.
 * Each test controls the mock's behaviour by emitting the appropriate events.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── http mock ─────────────────────────────────────────────────────────────────

/** Shared handle to the most recent fake request created by http.get(). */
let lastReq: FakeRequest | null = null;

class FakeRequest extends EventEmitter {
  destroy = vi.fn(() => this.emit("error", new Error("destroyed")));
}

class FakeResponse extends EventEmitter {
  statusCode: number;
  resume = vi.fn();
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
}

vi.mock("node:http", () => ({
  get: vi.fn(
    (
      _url: string,
      _opts: unknown,
      cb?: (res: FakeResponse) => void,
    ): FakeRequest => {
      const req = new FakeRequest();
      lastReq = req;
      // Store the response callback so tests can invoke it
      (req as any).__cb = cb;
      return req;
    },
  ),
}));

import * as http from "node:http";
import { pingBridge } from "../httpProbe";

beforeEach(() => {
  lastReq = null;
  vi.mocked(http.get).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── healthy probe ─────────────────────────────────────────────────────────────

describe("pingBridge — healthy probe", () => {
  it("returns true when the server responds with HTTP 200", async () => {
    const p = pingBridge(9999);
    // Simulate the server responding with 200
    const res = new FakeResponse(200);
    (lastReq as any).__cb(res);
    expect(await p).toBe(true);
    expect(res.resume).toHaveBeenCalledOnce(); // drain must be called
  });

  it("returns false when the server responds with HTTP 401 (not 200)", async () => {
    const p = pingBridge(9999);
    const res = new FakeResponse(401);
    (lastReq as any).__cb(res);
    expect(await p).toBe(false);
  });

  it("returns false when the server responds with HTTP 404", async () => {
    const p = pingBridge(9999);
    const res = new FakeResponse(404);
    (lastReq as any).__cb(res);
    expect(await p).toBe(false);
  });
});

// ── error / no-response ───────────────────────────────────────────────────────

describe("pingBridge — connection error", () => {
  it("returns false when the request emits an error (ECONNREFUSED)", async () => {
    const p = pingBridge(9999);
    lastReq!.emit(
      "error",
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    expect(await p).toBe(false);
  });

  it("never throws — all errors are caught and mapped to false", async () => {
    const p = pingBridge(9999);
    lastReq!.emit("error", new Error("unexpected"));
    await expect(p).resolves.toBe(false);
  });
});

// ── timeout ───────────────────────────────────────────────────────────────────

describe("pingBridge — timeout", () => {
  it("returns false and destroys the request when the timeout event fires", async () => {
    const p = pingBridge(9999);
    // Simulate timeout event (node fires this when `timeout` option elapses)
    lastReq!.emit("timeout");
    // destroy() emits error which resolves the promise to false
    expect(await p).toBe(false);
    expect(lastReq!.destroy).toHaveBeenCalledOnce();
  });
});

// ── port parameter ────────────────────────────────────────────────────────────

describe("pingBridge — URL construction", () => {
  it("sends the request to the correct port", async () => {
    const p = pingBridge(12345);
    lastReq!.emit("error", new Error("abort"));
    await p;
    const urlArg = vi.mocked(http.get).mock.calls[0][0] as string;
    expect(urlArg).toContain("12345");
    expect(urlArg).toContain("/ping");
    expect(urlArg).toContain("127.0.0.1");
  });

  it("uses a 3000ms timeout option", async () => {
    const p = pingBridge(9999);
    lastReq!.emit("error", new Error("abort"));
    await p;
    const optsArg = vi.mocked(http.get).mock.calls[0][1] as { timeout: number };
    expect(optsArg.timeout).toBe(3000);
  });
});
