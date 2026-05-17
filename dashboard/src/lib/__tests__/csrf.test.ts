/**
 * Unit tests for the requireSameOrigin CSRF guard helper.
 *
 * Mirrors the inline check that already lives in the bridge proxy + several
 * recipe routes. Centralising it here lets us cover the remaining mutation
 * routes (connector connect/disconnect, connector requests, push subscribe/
 * unsubscribe/test) without re-implementing the same five-line check six
 * times.
 */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { requireSameOrigin } from "@/lib/csrf";

function makeReq(
  secFetchSite: string | null,
  opts: { origin?: string | null; host?: string | null } = {},
): NextRequest {
  const headers = new Headers();
  if (secFetchSite !== null) headers.set("sec-fetch-site", secFetchSite);
  // Default host is what NextRequest uses; opts can override or null.
  if (opts.origin !== null && opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.host !== null && opts.host !== undefined) headers.set("host", opts.host);
  return new NextRequest("http://localhost:3200/api/test", {
    method: "POST",
    headers,
  });
}

describe("requireSameOrigin", () => {
  it("returns null when sec-fetch-site is same-origin", () => {
    expect(requireSameOrigin(makeReq("same-origin"))).toBeNull();
  });

  it("returns null when sec-fetch-site is none (address bar / bookmark)", () => {
    expect(requireSameOrigin(makeReq("none"))).toBeNull();
  });

  it("returns null when sec-fetch-site is absent but Origin matches Host (legacy browser)", () => {
    // #605 fix: tightened. Header absent → fall back to Origin/Host
    // equality check. This still works for legacy clients (Origin has
    // been universal on mutating verbs since ~2020) but blocks curl/
    // script with cookies that present no Origin at all.
    expect(
      requireSameOrigin(
        makeReq(null, { origin: "http://localhost:3200", host: "localhost:3200" }),
      ),
    ).toBeNull();
  });

  it("returns 403 when sec-fetch-site is absent and Origin is missing entirely (curl with cookies)", () => {
    const res = requireSameOrigin(makeReq(null, { origin: null, host: "localhost:3200" }));
    expect(res?.status).toBe(403);
  });

  it("returns 403 when sec-fetch-site is absent and Origin host differs from Host", () => {
    const res = requireSameOrigin(
      makeReq(null, { origin: "http://evil.example.com", host: "localhost:3200" }),
    );
    expect(res?.status).toBe(403);
  });

  it("returns 403 when sec-fetch-site is cross-site", () => {
    const res = requireSameOrigin(makeReq("cross-site"));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  it("returns 403 when sec-fetch-site is same-site (subdomain attacker)", () => {
    const res = requireSameOrigin(makeReq("same-site"));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  it("returns JSON error body on rejection", async () => {
    const res = requireSameOrigin(makeReq("cross-site"));
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body).toEqual({ error: "CSRF check failed" });
  });
});
