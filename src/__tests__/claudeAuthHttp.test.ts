/**
 * Tests for the Claude Code subscription OAuth/PKCE bridge endpoints.
 *
 * Audit 2026-06-08 HIGH (auth-1): handleClaudeAuthComplete's token-exchange
 * fetch had no timeout, so a slow/hung Anthropic endpoint kept the HTTP
 * connection + session open indefinitely. It must abort and return 504.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleClaudeAuthComplete,
  handleClaudeAuthStart,
} from "../claudeAuthHttp.js";

type Captured = { status: number; body: string };

function captureResponse(): { res: ServerResponse; result: Captured } {
  const result: Captured = { status: 0, body: "" };
  const chunks: string[] = [];
  const res = {
    writeHead: (status: number) => {
      result.status = status;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
      result.body = chunks.join("");
    },
  } as unknown as ServerResponse;
  return { res, result };
}

function fakeReq(body: string): IncomingMessage {
  // Emit a Buffer (not a string) — readBody does Buffer.concat(chunks).
  return Readable.from([
    Buffer.from(body, "utf8"),
  ]) as unknown as IncomingMessage;
}

async function startSession(): Promise<string> {
  const { res, result } = captureResponse();
  await handleClaudeAuthStart(fakeReq("{}"), res);
  return (JSON.parse(result.body) as { sessionId: string }).sessionId;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("handleClaudeAuthComplete", () => {
  it("returns 504 when the Anthropic token exchange times out", async () => {
    const sessionId = await startSession();
    vi.useFakeTimers();

    // fetch that never resolves until its AbortSignal fires.
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });

    const { res, result } = captureResponse();
    const p = handleClaudeAuthComplete(
      fakeReq(JSON.stringify({ sessionId, code: "the-code" })),
      res,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await p;

    expect(result.status).toBe(504);
    expect((JSON.parse(result.body) as { error: string }).error).toBe(
      "token_exchange_timeout",
    );
  });

  it("returns 200 with the token on success", async () => {
    const sessionId = await startSession();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok-xyz", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { res, result } = captureResponse();
    await handleClaudeAuthComplete(
      fakeReq(JSON.stringify({ sessionId, code: "the-code" })),
      res,
    );

    expect(result.status).toBe(200);
    expect((JSON.parse(result.body) as { token: string }).token).toBe(
      "tok-xyz",
    );
  });

  it("returns 502 on a network error (distinct from a timeout)", async () => {
    const sessionId = await startSession();
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const { res, result } = captureResponse();
    await handleClaudeAuthComplete(
      fakeReq(JSON.stringify({ sessionId, code: "the-code" })),
      res,
    );

    expect(result.status).toBe(502);
    expect((JSON.parse(result.body) as { error: string }).error).toBe(
      "token_exchange_failed",
    );
  });
});

describe("authorize URL client_id", () => {
  // claude.ai's /oauth/authorize rejects a non-UUID client_id with
  // "Input should be a valid UUID" and renders "OAuth Request Failed", so the
  // flow dies before the user can approve. The client-metadata URL previously
  // used here is exactly that shape, and the failure is invisible from the
  // bridge side: /start happily returns a URL that cannot work.
  it("sends a UUID client_id, not a client-metadata URL", async () => {
    const { res, result } = captureResponse();
    await handleClaudeAuthStart(fakeReq("{}"), res);
    const { url } = JSON.parse(result.body) as { url: string };
    const clientId = new URL(url).searchParams.get("client_id") ?? "";

    expect(clientId).not.toMatch(/^https?:\/\//);
    expect(clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("token exchange sends state (Invalid request format bug)", () => {
  // Anthropic's /v1/oauth/token rejects the request with
  //   {"error":{"type":"invalid_request_error","message":"Invalid request format"}}
  // when `state` is absent — verified against the live endpoint 2026-08-12 with
  // a junk code: form-encoded WITHOUT state → "Invalid request format";
  // form-encoded WITH state → "invalid_grant" (i.e. it got past the shape
  // check). Body encoding is NOT the trigger; the missing field is. This made
  // "Connect Claude" fail for every user regardless of what they pasted.
  it("includes state in the token-exchange body", async () => {
    const sessionId = await startSession();
    let sentBody = "";
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "sk-ant-oat01-x" }),
      });
    });

    const { res } = captureResponse();
    await handleClaudeAuthComplete(
      fakeReq(JSON.stringify({ sessionId, code: "the-code" })),
      res,
    );

    const sent = new URLSearchParams(sentBody);
    expect(sent.get("state")).toBeTruthy();
  });

  // Anthropic's callback page shows the value as `<code>#<state>`. Users paste
  // it verbatim (or paste the whole URL). Both must resolve to a bare code plus
  // the state, never a code with a "#..." suffix glued on.
  it("splits a pasted <code>#<state> value into code and state", async () => {
    const sessionId = await startSession();
    let sentBody = "";
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "sk-ant-oat01-x" }),
      });
    });

    const { res } = captureResponse();
    await handleClaudeAuthComplete(
      fakeReq(JSON.stringify({ sessionId, code: "abc123#st4te" })),
      res,
    );

    const sent = new URLSearchParams(sentBody);
    expect(sent.get("code")).toBe("abc123");
    expect(sent.get("state")).toBe("st4te");
  });

  it("accepts a full pasted callback URL", async () => {
    const sessionId = await startSession();
    let sentBody = "";
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "sk-ant-oat01-x" }),
      });
    });

    const { res } = captureResponse();
    await handleClaudeAuthComplete(
      fakeReq(
        JSON.stringify({
          sessionId,
          code: "https://platform.claude.com/oauth/code/callback?code=abc123&state=st4te",
        }),
      ),
      res,
    );

    const sent = new URLSearchParams(sentBody);
    expect(sent.get("code")).toBe("abc123");
    expect(sent.get("state")).toBe("st4te");
  });
});

describe("handleClaudeAuthStart session-map cap (http-routes-4)", () => {
  it("rejects new sessions with 503 once the map is at capacity", async () => {
    // The session map is module-scoped and shared across tests in this file,
    // so the starting count is non-zero. Keep firing /start; before the fix
    // every call returned 200 (unbounded growth). After the fix, once the map
    // reaches MAX_SESSIONS (500) the next /start returns 503. Cap iterations
    // generously above the ceiling so the loop terminates either way.
    let saw503 = false;
    let last503Body = "";
    for (let i = 0; i < 600 && !saw503; i++) {
      const { res, result } = captureResponse();
      await handleClaudeAuthStart(fakeReq("{}"), res);
      if (result.status === 503) {
        saw503 = true;
        last503Body = result.body;
      } else {
        expect(result.status).toBe(200);
      }
    }
    expect(saw503).toBe(true);
    expect((JSON.parse(last503Body) as { error: string }).error).toBe(
      "too_many_sessions",
    );
  });
});
