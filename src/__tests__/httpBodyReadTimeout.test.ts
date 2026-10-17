/**
 * The request timeout must cover reading the response body (audit M22).
 *
 * Both `http.post` (recipe tool) and `sendHttpRequest` (bridge tool) cleared
 * their abort timer as soon as response HEADERS arrived, then read the body
 * with no deadline. A server that answers at once and drips the body slowly
 * held the call open for as long as it liked.
 *
 * Real server: headers immediately, then one byte every 200 ms for 5 s.
 * Each tool is given a 500 ms timeout and must give up well before 5 s.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  _resetActiveProfileForTesting,
  COMPAT_PROFILE,
  setActiveProfile,
} from "../governance/profile.js";
import { executeTool } from "../recipes/toolRegistry.js";
import type { RunContext } from "../recipes/yamlRunner.js";
import { createSendHttpRequestTool } from "../tools/httpClient.js";
import "../recipes/tools/http.js";

let server: Server;
let url = "";
const open = new Set<NodeJS.Timeout>();

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/plain" });
    let n = 0;
    const tick = setInterval(() => {
      if (res.destroyed || n++ >= 25) {
        clearInterval(tick);
        open.delete(tick);
        if (!res.destroyed) res.end();
        return;
      }
      res.write("x");
    }, 200);
    open.add(tick);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/drip`;
});
afterAll(async () => {
  for (const t of open) clearInterval(t);
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => _resetActiveProfileForTesting());

async function elapsed(fn: () => Promise<unknown>) {
  const t = Date.now();
  let outcome: unknown;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = err;
  }
  return { ms: Date.now() - t, outcome };
}

describe("a slow-drip response body is bounded by the request timeout", () => {
  it("http.post gives up near its timeout, as an uncertain outcome", async () => {
    setActiveProfile(COMPAT_PROFILE);
    const params = { url, body: "{}", allowPrivate: true, timeoutMs: 500 };
    const { ms, outcome } = await elapsed(() =>
      executeTool("http.post", {
        params,
        step: { ...params, tool: "http.post" },
        ctx: { env: {}, steps: {} } as unknown as RunContext,
        // biome-ignore lint/suspicious/noExplicitAny: minimal StepDeps
        deps: { workdir: process.cwd() } as any,
      }),
    );
    expect(ms).toBeLessThan(2500);
    // Headers arrived, so the target received the write: the body failing
    // is an uncertain outcome, never a plain failure or a success.
    expect(String(outcome)).toMatch(/response body could not be read/);
  });

  it("sendHttpRequest gives up near its timeout and says it timed out", async () => {
    const tool = createSendHttpRequestTool({ allowPrivateHttp: true });
    const { ms, outcome } = await elapsed(() =>
      tool.handler({ method: "GET", url, timeoutMs: 500 }),
    );
    expect(ms).toBeLessThan(2500);
    expect(JSON.stringify(outcome)).toMatch(/timed out after 500ms/);
  });
});
