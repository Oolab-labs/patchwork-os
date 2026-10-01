/** @vitest-environment node */
/**
 * Sibling of the catch-all's segmentEncoding test. This route restricts POST
 * to `/recipes/<name>/run`, then joined the decoded name segments raw — so a
 * segment decoded from `%3F` rewrote the upstream path/query and the `/run`
 * restriction described an intent the wire did not carry. The local variable
 * was literally named `encodedName` and was not encoded.
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
}));

const { GET, POST, DELETE } = await import("../route");

function req(method: string): NextRequest {
  const r = new Request("https://dashboard.local/api/bridge/recipes/x", {
    method,
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: method === "GET" ? undefined : "{}",
  });
  Object.defineProperty(r, "nextUrl", {
    value: { search: "" },
    configurable: true,
  });
  return r as unknown as NextRequest;
}

const ctx = (name: string[]) => ({ params: Promise.resolve({ name }) });
const forwardedTarget = () => bridgeFetch.mock.calls.at(-1)?.[0];

describe("recipes/[...name] proxy — decoded segments are re-encoded on the wire", () => {
  beforeEach(() => bridgeFetch.mockClear());

  it("POST /run forwards a plain name unchanged", async () => {
    await POST(req("POST"), ctx(["morning-brief", "run"]));
    expect(forwardedTarget()).toBe("/recipes/morning-brief/run");
  });

  it("POST /run re-encodes a ? inside the name so the upstream path is still …/run", async () => {
    await POST(req("POST"), ctx(["foo?x", "run"]));
    expect(forwardedTarget()).toBe("/recipes/foo%3Fx/run");
  });

  it("GET re-encodes a slash inside a segment", async () => {
    await GET(req("GET"), ctx(["a/b"]));
    expect(forwardedTarget()).toBe("/recipes/a%2Fb");
  });

  it("DELETE re-encodes too", async () => {
    await DELETE(req("DELETE"), ctx(["a#b"]));
    expect(forwardedTarget()).toBe("/recipes/a%23b");
  });
});
