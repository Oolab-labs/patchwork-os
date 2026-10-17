/** @vitest-environment node */
/**
 * Audit 2026-10-15, M30. The L4 fix (#1667) gave proxied HTML a security
 * policy — but only on the generic `/api/bridge/[...path]` proxy. Dedicated
 * routes that relay a bridge body with the UPSTREAM content type rebuilt the
 * response with `content-type` alone, so bridge HTML (an error page in remote
 * mode, say) was served from the dashboard origin with no script policy. The
 * generic proxy's binary branch had the same gap for sniffing.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
  findBridge: () => ({ port: 3101, authToken: "t", workspace: "/w" }),
  resolveBridgeUrl: () => "http://127.0.0.1:3101",
}));
vi.mock("@/lib/csrf", () => ({ requireSameOrigin: () => null }));

beforeEach(() => {
  bridgeFetchMock.mockReset();
  vi.stubEnv("DASHBOARD_ALLOW_UNAUTHENTICATED", "1");
});
afterEach(() => vi.unstubAllEnvs());

const htmlNoCsp = () =>
  new Response("<html><script>alert(1)</script></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const ROUTES: Array<{ label: string; call: () => Promise<Response> }> = [
  {
    label: "recipes/simulate",
    call: async () =>
      (await import("../recipes/simulate/route")).GET(
        new NextRequest("http://localhost/api/bridge/recipes/simulate?recipe=probe"),
      ),
  },
  {
    label: "recipes/doctor",
    call: async () =>
      (await import("../recipes/doctor/route")).GET(
        new NextRequest("http://localhost/api/bridge/recipes/doctor?recipe=probe"),
      ),
  },
  {
    label: "workers/boundary",
    call: async () =>
      (await import("../workers/boundary/route")).GET(
        new NextRequest("http://localhost/api/bridge/workers/boundary?recipe=probe"),
      ),
  },
  {
    label: "connections",
    call: async () => (await import("../../connections/route")).GET(),
  },
];

describe("dedicated proxies give upstream HTML a security policy (M30)", () => {
  for (const r of ROUTES) {
    it(`${r.label}: HTML with no CSP gets the sandbox policy and nosniff`, async () => {
      bridgeFetchMock.mockResolvedValueOnce(htmlNoCsp());
      const res = await r.call();
      expect(res.headers.get("content-security-policy") ?? "").toContain("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  }
});

describe("generic proxy binary branch", () => {
  it("a binary download carries nosniff so it cannot be sniffed into HTML", async () => {
    const route = await import("../[...path]/route");
    bridgeFetchMock.mockResolvedValueOnce(
      new Response("bytes", { headers: { "content-type": "application/octet-stream" } }),
    );
    const res = await route.GET(new NextRequest("http://localhost/api/bridge/x"), {
      params: Promise.resolve({ path: ["x"] }),
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
