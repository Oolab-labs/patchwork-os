/** @vitest-environment node */
/**
 * Tests for the /api/bridge/recipes/simulate proxy — translates the
 * `?recipe=` query into the bridge's path param `/recipes/:name/simulate`.
 * A dedicated static segment is required so the request doesn't fall through
 * to the dynamic `recipes/[...name]` catch-all proxy.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeFetch } from "@/lib/bridge";

vi.mock("@/lib/bridge", () => ({ bridgeFetch: vi.fn() }));

import { GET } from "../route";

const mockBridgeFetch = vi.mocked(bridgeFetch);

function req(url: string): NextRequest {
  return new NextRequest(`https://dashboard.local${url}`);
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({ report: { kind: "what-if-preview" } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  mockBridgeFetch.mockReset();
  mockBridgeFetch.mockResolvedValue(okResponse());
});

describe("GET /api/bridge/recipes/simulate", () => {
  it("400s when the recipe query is missing", async () => {
    const res = await GET(req("/api/bridge/recipes/simulate"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_recipe" });
    expect(mockBridgeFetch).not.toHaveBeenCalled();
  });

  it("translates ?recipe= into the bridge path param and forwards the body", async () => {
    const res = await GET(
      req("/api/bridge/recipes/simulate?recipe=morning-brief"),
    );
    expect(mockBridgeFetch).toHaveBeenCalledWith(
      "/recipes/morning-brief/simulate",
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      report: { kind: "what-if-preview" },
    });
  });

  it("encodes scoped recipe names safely", async () => {
    await GET(req("/api/bridge/recipes/simulate?recipe=%40scope%2Ffoo"));
    expect(mockBridgeFetch).toHaveBeenCalledWith(
      "/recipes/%40scope%2Ffoo/simulate",
      { method: "GET" },
    );
  });

  it("502s when the bridge is unreachable", async () => {
    mockBridgeFetch.mockRejectedValueOnce(new Error("down"));
    const res = await GET(req("/api/bridge/recipes/simulate?recipe=x"));
    expect(res.status).toBe(502);
  });
});
