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

// ── LOW #11 — module-level cache shared across instances ──────────────────────

function jsonRpcResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("McpClient instance-level cache isolation (LOW #11)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("two instances with the same cacheKey do not share cached results", async () => {
    // Both clients call the same tool with the same cacheKey. Before the fix
    // the module-level cache meant instanceB would return instanceA's cached
    // result instead of making its own network call.
    let fetchCallCount = 0;

    function makeSuccessResponse(id: number, _value: string): Response {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    function makeToolResponse(id: number, text: string): Response {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text }],
            isError: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        method?: string;
        id?: number;
      };
      fetchCallCount += 1;
      if (body.method === "initialize")
        return makeSuccessResponse(body.id ?? 0, "init");
      if (body.method === "notifications/initialized")
        return new Response("", { status: 202 });
      if (body.method === "tools/call") {
        // Return different payloads depending on call order so we can detect
        // if the second client got the first client's cached response.
        const responseText =
          fetchCallCount <= 3 ? "result-from-client-A" : "result-from-client-B";
        return makeToolResponse(body.id ?? 0, responseText);
      }
      return makeSuccessResponse(body.id ?? 0, "ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const clientA = new McpClient(
      "https://mcp.test/mcp",
      async () => "token-a",
    );
    const clientB = new McpClient(
      "https://mcp.test/mcp",
      async () => "token-b",
    );

    const CACHE_KEY = "shared-cache-key";
    const resultA = await clientA.callTool(
      "myTool",
      {},
      { cacheKey: CACHE_KEY, cacheTtlMs: 60_000 },
    );
    const resultB = await clientB.callTool(
      "myTool",
      {},
      { cacheKey: CACHE_KEY, cacheTtlMs: 60_000 },
    );

    // After the fix each instance has its own cache so both make network calls
    // and resultB carries the second response, not the first client's cached value.
    const textA = resultA.content.find((c) => c.type === "text")?.text;
    const textB = resultB.content.find((c) => c.type === "text")?.text;

    // With the module-level cache (bug), clientB would return "result-from-client-A".
    // With per-instance cache (fix), clientB makes its own call and gets a different value.
    expect(textA).toBe("result-from-client-A");
    expect(textB).not.toBe("result-from-client-A");
  });
});

describe("McpClient concurrent-init dedup (connectors-core-1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends exactly one initialize POST when two callers race before init completes", async () => {
    let initializeCount = 0;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        method?: string;
        id?: number;
      };
      if (body.method === "initialize") {
        initializeCount += 1;
        // Hold the first initialize open briefly so the second concurrent caller
        // has a window to (incorrectly) fire its own initialize. With the dedup
        // fix it awaits the same in-flight promise instead.
        return new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(jsonRpcResponse(body.id ?? 0, { ok: true })),
            5,
          );
        });
      }
      if (body.method === "notifications/initialized")
        return new Response("", { status: 202 });
      if (body.method === "tools/list")
        return jsonRpcResponse(body.id ?? 0, { tools: [] });
      return jsonRpcResponse(body.id ?? 0, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient(
      "https://mcp.example.test/mcp",
      async () => "token",
    );

    // Fire two initialization-dependent calls concurrently.
    await Promise.all([client.listTools(), client.listTools()]);

    expect(initializeCount).toBe(1);
  });
});

describe("McpClient upstream error redaction (connectors-core-2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("truncates/sanitizes upstream JSON-RPC error.message before throwing", async () => {
    const leak = `internal context: token=SECRET_LEAK_99 requestId=abc ${"x".repeat(400)}`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        method?: string;
        id?: number;
      };
      if (body.method === "initialize")
        return jsonRpcResponse(body.id ?? 0, { ok: true });
      if (body.method === "notifications/initialized")
        return new Response("", { status: 202 });
      // tools/list returns a JSON-RPC error carrying a long leaky message.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? 0,
          error: { code: -32000, message: leak },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient(
      "https://mcp.example.test/mcp",
      async () => "token",
    );

    let caught: Error | undefined;
    try {
      await client.listTools();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // The raw upstream message is truncated to <=120 chars, so the secret that
    // lives near the start may survive — but the trailing padding must be gone,
    // proving truncation. Assert the message is bounded and the code is shown.
    expect(caught?.message).toMatch(/code: -32000/);
    // The full 400-char padding must NOT appear verbatim.
    expect(caught?.message).not.toContain("x".repeat(200));
  });
});

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

  it("does not embed the upstream error body in the thrown Error (audit 2026-06-09 connector-new-5)", async () => {
    // A non-401 upstream error whose body carries a secret. The thrown Error
    // propagates into recipe tool results → LLM context, so it must surface only
    // the status, never the raw body.
    const leakyBody = JSON.stringify({
      error: "internal",
      token: "UPSTREAM_SECRET_TOKEN_42",
      stack: "at Server.handler (/srv/secret/path.js:1:1)",
    });
    const getAccessToken = vi.fn(async () => "any-token");
    const fetchMock = vi.fn(
      async () => new Response(leakyBody, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient(
      "https://mcp.example.test/mcp",
      getAccessToken,
    );

    let caught: Error | undefined;
    try {
      await client.listTools();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain("UPSTREAM_SECRET_TOKEN_42");
    expect(caught?.message).not.toContain("/srv/secret/path.js");
    expect(caught?.message).not.toContain("token");
    // Status is still surfaced for diagnosis.
    expect(caught?.message).toMatch(/500/);
  });

  it("calls onUnauthorized callback before retrying on 401 so stale token cache is invalidated (H3)", async () => {
    const getAccessToken = vi.fn(async () => "stale-token");
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpClient(
      "https://mcp.example.test/mcp",
      getAccessToken,
      { onUnauthorized },
    );

    const ok = await client.ping();
    expect(ok).toBe(false);

    // onUnauthorized must have been called before the retry so callers can
    // invalidate their token cache — otherwise the second getAccessToken()
    // returns the same stale token (audit 2026-06-19 H3).
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
