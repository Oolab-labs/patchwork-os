/** @vitest-environment node */
/**
 * Tests for the dashboard login route (`POST /api/login`).
 *
 * Focus: the brute-force lockout must not turn into a global denial of
 * service when no trusted reverse proxy is configured. Without
 * BRIDGE_TRUST_PROXY=true, clientKey() returns the literal "unknown" for
 * EVERY request, so a shared lockout keyed on that string would lock out
 * all users after MAX_FAILURES bad passwords (the common local / direct
 * deploy case). With a trusted proxy + distinct client IPs, per-IP lockout
 * must still work. Audit 2026-06-02.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/login/route";
import { _config, _globalConfig, _resetForTests } from "@/lib/authRateLimit";

const PASSWORD = "correct-horse-battery-staple";
const SECRET = "0123456789abcdef0123456789abcdef";

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

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3200/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/login — no trusted proxy (BRIDGE_TRUST_PROXY unset)", () => {
  it("does NOT lock out a subsequent correct login after many bad attempts", async () => {
    // Hammer the endpoint with more than MAX_FAILURES wrong passwords. All
    // requests bucket into "unknown" because there's no trusted proxy.
    for (let i = 0; i < _config.MAX_FAILURES + 3; i++) {
      const r = await POST(req({ password: "wrong" }));
      // Each wrong attempt is a 401, never a 429 shared lockout.
      expect(r.status).toBe(401);
    }

    // A legitimate user with the right password must still get in — the
    // shared "unknown" bucket must NOT have locked everyone out.
    const ok = await POST(req({ password: PASSWORD }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("never returns 429 for the shared 'unknown' bucket", async () => {
    for (let i = 0; i < _config.MAX_FAILURES + 5; i++) {
      const r = await POST(req({ password: "nope" }));
      expect(r.status).not.toBe(429);
    }
  });
});

describe("POST /api/login — long-password compare (audit 2026-06-03 HIGH #2)", () => {
  // The compare padded both inputs into a fixed 256-byte buffer but SKIPPED
  // the copy when an input exceeded 256 bytes (`if (b.length <= PAD)`), leaving
  // that buffer all-zeros. Two >256-byte inputs of equal length therefore both
  // compared as all-zeros → any same-length payload authenticated. JWT-style
  // tokens (200-400 bytes) make this practical.
  const LONG = "x".repeat(300);

  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = LONG;
  });

  it("rejects a wrong password of the same (>256-byte) length", async () => {
    const attempt = "y".repeat(300); // same length, different content
    const r = await POST(req({ password: attempt }));
    expect(r.status).toBe(401);
  });

  it("still accepts the correct >256-byte password", async () => {
    const ok = await POST(req({ password: LONG }));
    expect(ok.status).toBe(200);
  });

  it("rejects a wrong password that shares the first 256 bytes", async () => {
    const attempt = "x".repeat(256) + "z".repeat(44); // first 256 identical
    const r = await POST(req({ password: attempt }));
    expect(r.status).toBe(401);
  });
});

describe("POST /api/login — global rate limit when no trusted proxy (audit 2026-06-03 MEDIUM #18)", () => {
  // When BRIDGE_TRUST_PROXY is not configured, clientKey() returns "unknown"
  // for every request. The previous code had no rate limiting for that bucket
  // to avoid DoS-ing all users with a shared lockout. The fix adds a global
  // fallback bucket with a much higher threshold (GLOBAL_MAX_FAILURES, default 50)
  // so automated attacks are still bounded while legitimate users aren't locked out.
  it("eventually rate-limits after GLOBAL_MAX_FAILURES wrong attempts from unknown IP", async () => {
    let got429 = false;
    for (let i = 0; i <= _globalConfig.GLOBAL_MAX_FAILURES; i++) {
      const r = await POST(req({ password: "wrong" }));
      if (r.status === 429) {
        got429 = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(got429).toBe(true);
  });
});

describe("POST /api/login — trusted proxy (BRIDGE_TRUST_PROXY=true)", () => {
  beforeEach(() => {
    process.env.BRIDGE_TRUST_PROXY = "true";
  });

  it("locks out a single abusive IP after MAX_FAILURES, returning 429", async () => {
    const attacker = { "x-forwarded-for": "203.0.113.7" };
    let last: Response | undefined;
    for (let i = 0; i < _config.MAX_FAILURES; i++) {
      last = await POST(req({ password: "wrong" }, attacker));
    }
    // The MAX_FAILURES-th failure trips the lockout.
    expect(last?.status).toBe(429);
    // And a follow-up attempt from the same IP is still locked, even with
    // the correct password.
    const blocked = await POST(req({ password: PASSWORD }, attacker));
    expect(blocked.status).toBe(429);
  });

  it("does not lock a different IP just because another IP was locked", async () => {
    const attacker = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < _config.MAX_FAILURES; i++) {
      await POST(req({ password: "wrong" }, attacker));
    }
    // A distinct, well-behaved IP logging in correctly must succeed.
    const legit = { "x-forwarded-for": "198.51.100.9" };
    const ok = await POST(req({ password: PASSWORD }, legit));
    expect(ok.status).toBe(200);
  });
});
