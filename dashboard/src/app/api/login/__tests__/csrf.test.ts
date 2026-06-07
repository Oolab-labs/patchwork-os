/** @vitest-environment node */
/**
 * LOW #37 — POST /api/login CSRF guard
 *
 * A cross-origin page can POST a form with Content-Type
 * application/x-www-form-urlencoded (browsers allow it in cross-origin forms).
 * The endpoint must reject requests that don't originate from the same site.
 * The fix uses requireSameOrigin() which checks sec-fetch-site.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/login/route";
import { _resetForTests } from "@/lib/authRateLimit";

const PASSWORD = "test-pass-csrf";
const SECRET = "deadbeefdeadbeefdeadbeefdeadbeef";

const ENV_KEYS = [
  "DASHBOARD_PASSWORD",
  "DASHBOARD_SESSION_SECRET",
  "BRIDGE_TRUST_PROXY",
] as const;

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.DASHBOARD_SESSION_SECRET = SECRET;
  delete process.env.BRIDGE_TRUST_PROXY;
  _resetForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  _resetForTests();
});

describe("POST /api/login — CSRF guard (LOW #37)", () => {
  it("rejects a cross-origin form POST (sec-fetch-site: cross-site) with 403", async () => {
    // A cross-origin page can submit application/x-www-form-urlencoded forms —
    // this must be blocked before the password is even checked.
    const formBody = `password=${encodeURIComponent(PASSWORD)}`;
    const r = await POST(
      new NextRequest("http://localhost:3200/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
        },
        body: formBody,
      }),
    );
    expect(r.status).toBe(403);
  });

  it("rejects a cross-origin JSON POST (sec-fetch-site: cross-site) with 403", async () => {
    // Even a CORS-preflight-gated JSON POST from cross-site must be blocked.
    const r = await POST(
      new NextRequest("http://localhost:3200/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(r.status).toBe(403);
  });

  it("allows a same-origin POST (sec-fetch-site: same-origin)", async () => {
    const r = await POST(
      new NextRequest("http://localhost:3200/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(r.status).toBe(200);
  });

  it("allows a direct navigation POST (sec-fetch-site: none)", async () => {
    // sec-fetch-site: none means direct navigation (no cross-origin involved)
    const r = await POST(
      new NextRequest("http://localhost:3200/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "none",
        },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(r.status).toBe(200);
  });
});
