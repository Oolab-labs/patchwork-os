/** @vitest-environment node */
/**
 * The catch-all forwards whatever path it is handed to the bridge with the
 * bridge bearer. Next decodes route params before the handler sees them, so a
 * request for `/api/bridge/recipes%2Finstall` — which the static
 * `recipes/install` route does NOT match (it needs a literal slash) — reaches
 * this handler as the single segment "recipes/install". Joined raw, the bridge
 * received `POST /recipes/install`: the dedicated proxy's per-session rate
 * limit and `assertValidInstallSource` were bypassed. Confirmed empirically
 * 2026-10-01 against `next dev` (405 from the static route with a literal
 * slash; the bridge's own JSON with `%2F`). The same join let `%3F` become a
 * real `?`, rewriting the upstream query.
 *
 * The fix is to re-encode each decoded segment before joining, so the bridge
 * sees exactly the one-segment path the client sent and 404s it.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridgeFetch = vi.fn<(target: string, init?: RequestInit) => Promise<Response>>(
  async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (target: string, init?: RequestInit) => bridgeFetch(target, init),
  findBridge: () => null,
  resolveBridgeUrl: () => "http://127.0.0.1:9999/",
}));

const { GET, POST } = await import("../route");

function getReq(search = ""): NextRequest {
  const req = new Request(`https://dashboard.local/api/bridge/x${search}`, {
    method: "GET",
  });
  Object.defineProperty(req, "nextUrl", {
    value: { search },
    configurable: true,
  });
  return req as unknown as NextRequest;
}

function postReq(): NextRequest {
  const req = new Request("https://dashboard.local/api/bridge/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: "{}",
  });
  Object.defineProperty(req, "nextUrl", {
    value: { search: "" },
    configurable: true,
  });
  return req as unknown as NextRequest;
}

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });
const forwardedTarget = () => bridgeFetch.mock.calls.at(-1)?.[0];

describe("catch-all bridge proxy — decoded segments are re-encoded on the wire", () => {
  beforeEach(() => bridgeFetch.mockClear());

  it("plain segments are forwarded unchanged", async () => {
    await GET(getReq("?a=1"), ctx(["recipes", "morning-brief"]));
    expect(forwardedTarget()).toBe("/recipes/morning-brief?a=1");
  });

  it("a single segment containing a slash does NOT become two path segments upstream", async () => {
    await POST(postReq(), ctx(["recipes/install"]));
    expect(forwardedTarget()).toBe("/recipes%2Finstall");
    expect(forwardedTarget()).not.toBe("/recipes/install");
  });

  it("a segment containing ? does NOT start an upstream query string", async () => {
    await GET(getReq(), ctx(["recipes", "doctor?recipe=x"]));
    expect(forwardedTarget()).toBe("/recipes/doctor%3Frecipe%3Dx");
  });

  it("the real query string is still appended after the encoded path", async () => {
    await GET(getReq("?recipe=x"), ctx(["recipes", "doctor"]));
    expect(forwardedTarget()).toBe("/recipes/doctor?recipe=x");
  });
});
