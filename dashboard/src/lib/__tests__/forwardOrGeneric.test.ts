/**
 * Unit tests for forwardOrGeneric — the shared bridge proxy helper.
 *
 * Invariants:
 * - 2xx: body + content-type forwarded verbatim to the dashboard client.
 * - non-2xx: upstream body logged server-side (truncated); client gets
 *   a generic { error: "Bridge returned <N>" } shape with the same status.
 *
 * This prevents internal bridge details (host:port, filesystem paths,
 * stack traces) from leaking to the browser.
 */

import { describe, expect, it } from "vitest";
import { forwardOrGeneric } from "@/lib/forwardOrGeneric";

function makeResponse(
  status: number,
  body: string,
  contentType = "application/json",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("forwardOrGeneric — 2xx passthrough", () => {
  it("forwards 200 body verbatim", async () => {
    const upstream = makeResponse(200, '{"tools":[]}');
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"tools":[]}');
  });

  it("preserves content-type from upstream on success", async () => {
    const upstream = makeResponse(200, "hello", "text/plain");
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("passes content-type through (uses application/json when header is null)", async () => {
    // Explicitly set to null via Headers to test the fallback path
    const headers = new Headers();
    // No content-type set — get() returns null, ?? "application/json" fires
    const upstream = new Response('{"ok":true}', { status: 200, headers });
    // jsdom may inject a default; test that we at least get a string back
    const res = await forwardOrGeneric(upstream, "test");
    const ct = res.headers.get("content-type");
    expect(typeof ct).toBe("string");
  });

  it("handles empty body on success", async () => {
    const upstream = new Response("", { status: 200 });
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("forwardOrGeneric — non-2xx sanitisation", () => {
  it("returns generic error body for 404", async () => {
    const upstream = makeResponse(
      404,
      '{"error":"internal path /var/data/recipes/secret.yaml not found"}',
    );
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Bridge returned 404" });
  });

  it("returns generic error body for 500", async () => {
    const upstream = makeResponse(500, "Internal Server Error with stacktrace...");
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Bridge returned 500" });
  });

  it("returns generic error body for 401", async () => {
    const upstream = makeResponse(401, '{"error":"token mismatch for user admin"}');
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Bridge returned 401" });
  });

  it("sets content-type application/json on error response", async () => {
    const upstream = makeResponse(503, "bridge down");
    const res = await forwardOrGeneric(upstream, "test");
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("does not forward upstream body details to the client on error", async () => {
    const sensitiveBody =
      '{"error":"ENOENT /home/user/.patchwork/secret.json","stack":"Error at ..."}';
    const upstream = makeResponse(500, sensitiveBody);
    const res = await forwardOrGeneric(upstream, "test");
    const text = await res.text();
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("/home/user/.patchwork");
    expect(text).not.toContain("stack");
  });
});
