/** @vitest-environment node */
/**
 * Tests for the shared body-cap helper used by every dashboard → bridge
 * proxy route. The helper protects dashboard heap from authenticated
 * callers streaming oversized bodies. Layered defenses:
 *   1. Content-Length pre-check rejects obviously oversized declarations
 *      before reading any body bytes.
 *   2. Streamed accumulation aborts the moment cumulative bytes exceed
 *      the cap — defeats chunked-encoded uploads with no Content-Length.
 */

import { describe, expect, it } from "vitest";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "../readBodyWithCap";

function reqWithBody(body: string, contentLength?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request("https://dashboard.local/x", {
    method: "POST",
    headers,
    body,
  });
}

describe("readBodyWithCap — Content-Length pre-check", () => {
  it("rejects declared Content-Length exceeding the cap", async () => {
    const result = await readBodyWithCap(reqWithBody("x", "999999"), 1024);
    expect(result.ok).toBe(false);
  });

  it("accepts declared Content-Length under the cap", async () => {
    const body = "hello";
    const result = await readBodyWithCap(
      reqWithBody(body, String(Buffer.byteLength(body))),
      1024,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("hello");
  });

  it("ignores non-numeric Content-Length and still streams safely", async () => {
    const body = "ok";
    const result = await readBodyWithCap(
      reqWithBody(body, "not-a-number"),
      1024,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("ok");
  });
});

describe("readBodyWithCap — streamed accumulation cap", () => {
  it("aborts when accumulated bytes exceed the cap (no Content-Length)", async () => {
    // 4 KB body, 1 KB cap. Don't include Content-Length so the pre-check
    // can't short-circuit; force the streaming path to enforce the cap.
    const body = "a".repeat(4 * 1024);
    const req = new Request("https://dashboard.local/x", {
      method: "POST",
      body,
    });
    // Strip Content-Length that fetch added implicitly.
    const stripped = new Request(req, { headers: { "content-type": "text/plain" } });
    const result = await readBodyWithCap(stripped, 1024);
    expect(result.ok).toBe(false);
  });

  it("returns empty body when there is no body stream", async () => {
    const req = new Request("https://dashboard.local/x", { method: "GET" });
    const result = await readBodyWithCap(req, 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("");
  });

  it("returns the full body when under the cap", async () => {
    const result = await readBodyWithCap(reqWithBody("under cap"), 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe("under cap");
  });
});

describe("BRIDGE_BODY_CAPS sizing", () => {
  it("each cap is at least 2× the bridge-side cap (sanity check)", () => {
    // Bridge-side caps from src/recipeRoutes.ts RECIPE_ROUTE_BODY_CAPS.
    // If these change without updating BRIDGE_BODY_CAPS the proxy can
    // either over-reject (legitimate requests get 413) or under-reject
    // (defense gap re-opens). Locked here so future changes hit a test.
    const bridgeSide = {
      install: 4 * 1024,
      generate: 4 * 1024,
      run: 32 * 1024,
      content: 256 * 1024,
    };
    expect(BRIDGE_BODY_CAPS.install).toBeGreaterThanOrEqual(bridgeSide.install * 2);
    expect(BRIDGE_BODY_CAPS.generate).toBeGreaterThanOrEqual(bridgeSide.generate * 2);
    expect(BRIDGE_BODY_CAPS.run).toBeGreaterThanOrEqual(bridgeSide.run * 2);
    expect(BRIDGE_BODY_CAPS.content).toBeGreaterThanOrEqual(bridgeSide.content * 2);
  });

  it("genericProxy is at least the streamable HTTP transport cap (1 MB)", () => {
    // src/streamableHttp.ts: BODY_SIZE_LIMIT = 1 MB. Catch-all proxy
    // covers any path the named routes don't, so it needs at least the
    // largest bridge cap.
    expect(BRIDGE_BODY_CAPS.genericProxy).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

describe("bodyTooLargeResponse", () => {
  it("returns 413 with JSON body containing maxBytes", async () => {
    const res = bodyTooLargeResponse(8192);
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toBe("application/json");
    const data = (await res.json()) as { error: string; maxBytes: number };
    expect(data.error).toMatch(/too large/i);
    expect(data.maxBytes).toBe(8192);
  });
});
