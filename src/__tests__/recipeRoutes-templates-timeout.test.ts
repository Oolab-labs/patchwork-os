/**
 * /templates — registry fetch must be abortable (RELIABILITY).
 *
 * The handler fetches the public template registry index.json from the
 * GitHub CDN. Without an AbortController the request parks the handler
 * indefinitely on a stalled connection — the negative-cache sentinel only
 * fires on rejection, which a hung socket never produces. Every other
 * fetch site in recipeRoutes.ts already wraps fetch in an AbortController
 * timeout; this test pins the /templates fetch to the same idiom by
 * asserting it passes an AbortSignal.
 *
 * Tests stub `globalThis.fetch` to fully control upstream + capture the
 * call args; no real network IO. Pattern mirrors
 * `recipeRoutes-bundle-install.test.ts`.
 */

import http from "node:http";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-templates-timeout-token-000000000000";

let server: Server | null = null;
let port = 0;
const originalFetch = globalThis.fetch;

function makeRequest(
  options: http.RequestOptions,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (status: number, data: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ status, body: data });
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => finish(res.statusCode ?? 0, data));
        res.on("error", () => finish(res.statusCode ?? 0, data));
        res.on("close", () => finish(res.statusCode ?? 0, data));
      },
    );
    req.on("error", (err) => {
      if (resolved) return;
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const templatesPath = {
  method: "GET" as const,
  path: "/templates",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
  },
};

describe("Server /templates — registry fetch is abortable", () => {
  it("passes an AbortSignal to fetch (timeout wiring)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recipes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;

    const { status } = await makeRequest(templatesPath);
    expect(status).toBe(200);

    // The handler must wrap the upstream fetch in an AbortController so a
    // stalled CDN connection can't park the request handler forever.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toBeDefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
