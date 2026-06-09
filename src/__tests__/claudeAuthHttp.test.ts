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
