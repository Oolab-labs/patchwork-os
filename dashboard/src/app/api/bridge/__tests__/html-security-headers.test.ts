/** @vitest-environment node */
/**
 * Security sweep L4. The proxy rebuilt every text response with only a
 * `content-type`, so bridge HTML (e.g. an OAuth approval page carrying
 * `default-src 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`)
 * was re-served from the DASHBOARD origin without its policy. The dashboard's
 * own next.config CSP is `frame-ancestors` only, so bridge HTML ran at the
 * dashboard origin with no script restriction.
 *
 * Fix: forward the upstream security headers, and give any HTML that arrives
 * without a CSP a locked-down sandbox policy. The dashboard never renders
 * proxied HTML as a page (it fetches JSON), so locking HTML down costs nothing.
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

const route = await import("../[...path]/route");

async function get(upstream: Response): Promise<Response> {
  bridgeFetchMock.mockResolvedValueOnce(upstream);
  return route.GET(new NextRequest("http://localhost/api/bridge/x"), {
    params: Promise.resolve({ path: ["x"] }),
  });
}

beforeEach(() => {
  bridgeFetchMock.mockReset();
  vi.stubEnv("DASHBOARD_ALLOW_UNAUTHENTICATED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxied HTML keeps a security policy (L4)", () => {
  it("forwards the bridge's own CSP, X-Frame-Options and nosniff", async () => {
    const csp = "default-src 'none'; frame-ancestors 'none'";
    const res = await get(
      new Response("<html></html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
        },
      }),
    );
    expect(res.headers.get("content-security-policy")).toBe(csp);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("locks down HTML that arrives with no CSP", async () => {
    const res = await get(
      new Response("<html><script>x</script></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/sandbox/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves JSON responses alone (control)", async () => {
    const res = await get(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
