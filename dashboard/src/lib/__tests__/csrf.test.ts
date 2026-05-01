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

function makeReq(secFetchSite: string | null): NextRequest {
  const headers = new Headers();
  if (secFetchSite !== null) headers.set("sec-fetch-site", secFetchSite);
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

  it("returns null when sec-fetch-site header is absent (older browsers)", () => {
    // Matches the existing bridge proxy behaviour — header missing → allow.
    // sec-fetch-site is universally supported in modern browsers, but legacy
    // automation tools may omit it.
    expect(requireSameOrigin(makeReq(null))).toBeNull();
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
