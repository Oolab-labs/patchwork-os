/** @vitest-environment node */
/**
 * Tests for the /api/bridge/copilot/message proxy — same body-size-cap
 * pattern as recipes/generate's proxy test (2026-05-07 security audit).
 */
import { describe, expect, it, vi } from "vitest";

import { POST } from "../route";

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: vi.fn(async () =>
    new Response(JSON.stringify({ reply: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

function makeReq(body: string, contentLength?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request(
    "https://dashboard.local/api/bridge/copilot/message",
    { method: "POST", headers, body },
  );
}

describe("POST /api/bridge/copilot/message — body size cap", () => {
  it("rejects oversized request via Content-Length with 413", async () => {
    const res = await POST(makeReq("x", "9999999"));
    expect(res.status).toBe(413);
  });

  it("rejects oversized body even when Content-Length is missing", async () => {
    const huge = "a".repeat(16 * 1024); // 16 KB > 8 KB cap
    const res = await POST(makeReq(huge));
    expect(res.status).toBe(413);
  });

  it("forwards a normal-sized request body", async () => {
    const body = JSON.stringify({ text: "pause nightly-review" });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ reply: "ok" });
  });
});
