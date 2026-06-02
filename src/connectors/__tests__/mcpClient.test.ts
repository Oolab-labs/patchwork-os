/**
 * Regression test: McpClient.post must reactively refresh + retry once on an
 * upstream 401.
 *
 * MCP connectors (GitHub / Linear) cache the OAuth access token between calls.
 * When the upstream server rejects a still-cached token with 401 (e.g. the
 * token was revoked or rotated server-side before our local expiry buffer
 * tripped), the client must re-fetch the token (re-entering refreshIfNeeded in
 * mcpOAuth) and retry the POST exactly once — not throw on the first 401.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../mcpClient.js";

function jsonRpcResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("McpClient 401 refresh + retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refreshes the token once and retries the POST after a 401", async () => {
    // getAccessToken yields a stale token first, then a fresh one. Subsequent
    // posts (notifications/initialized, tools/list) re-read the fresh token.
    let refreshes = 0;
    const getAccessToken = vi.fn(async () => {
      // The first call returns the stale token; every call after the 401-driven
      // re-fetch returns the refreshed token.
      if (refreshes === 0) {
        refreshes = 1;
        return "stale-token";
      }
      return "fresh-token";
    });

    // First fetch (initialize) → 401. After the retry, all posts succeed.
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) return new Response("unauthorized", { status: 401 });
      // Retry of initialize + notifications + tools/list: valid JSON-RPC.
      return jsonRpcResponse(call, { tools: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient(
      "https://mcp.example.test/mcp",
      getAccessToken,
    );

    // ping → listTools → ensureInitialized → first post is `initialize`,
    // which 401s, triggers a single token re-fetch + retry, then succeeds.
    const ok = await client.ping();

    expect(ok).toBe(true);
    // The retried (2nd) fetch carried the refreshed token, proving the client
    // re-fetched the access token after the 401 and used it on the retry.
    const secondCallHeaders = fetchMock.mock.calls[1]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(secondCallHeaders?.Authorization).toBe("Bearer fresh-token");
    // The first (401'd) fetch carried the stale token.
    const firstCallHeaders = fetchMock.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(firstCallHeaders?.Authorization).toBe("Bearer stale-token");
  });

  it("does not retry more than once (no infinite loop) on repeated 401", async () => {
    const getAccessToken = vi.fn(async () => "any-token");
    const fetchMock = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient(
      "https://mcp.example.test/mcp",
      getAccessToken,
    );

    // Always-401: ping() swallows the throw and returns false.
    const ok = await client.ping();
    expect(ok).toBe(false);

    // Exactly one initialize POST + one retry = 2 fetches; no infinite loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Token re-fetched once for the retry.
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});
