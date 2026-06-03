import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  checkLocked,
  recordFailure,
  recordSuccess,
} from "@/lib/authRateLimit";
import { clientKey } from "@/lib/clientIp";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";
import { sessionCookieHeader, signSession } from "@/lib/session";

/**
 * Dashboard login. Replaces Basic auth so the iOS PWA isn't re-prompted
 * on every cold launch. Validates a single shared password (timing-safe)
 * and sets an HMAC-signed HttpOnly session cookie on success.
 *
 * Rate-limited per client IP via the same module the previous Basic-auth
 * middleware used — so brute-forcing the password is bounded.
 */

interface LoginBody {
  password?: unknown;
  next?: unknown;
}

function isSafeRedirect(next: unknown): next is string {
  if (typeof next !== "string" || next.length === 0) return false;
  // Same-origin only — must start with `/` and not `//` (protocol-relative).
  if (!next.startsWith("/")) return false;
  if (next.startsWith("//")) return false;
  if (next.startsWith("/\\")) return false;
  return true;
}

export async function POST(req: NextRequest) {
  const expected = process.env.DASHBOARD_PASSWORD ?? "";
  const secret = process.env.DASHBOARD_SESSION_SECRET ?? "";
  if (!expected || !secret) {
    return NextResponse.json(
      {
        error:
          "auth not configured (DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET must be set)",
      },
      { status: 503 },
    );
  }

  const ip = clientKey(req.headers);
  // When no trusted reverse proxy is configured, clientKey() returns the
  // literal "unknown" for EVERY request — so a shared lockout keyed on it
  // would let 5 bad passwords from anyone lock out ALL users for the
  // lockout window (the common local / direct-deploy case). Only apply the
  // per-IP brute-force lockout when we have a real, attributable client key
  // (i.e. BRIDGE_TRUST_PROXY=true + a forwarded IP). Without it we rely on
  // the timing-safe password compare below as the sole gate. Audit 2026-06-02.
  const trackable = ip !== "unknown";
  if (trackable) {
    const lock = checkLocked(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: "too many attempts" },
        { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } },
      );
    }
  }

  const parsed = await readJsonWithCap<LoginBody>(
    req,
    DASHBOARD_API_BODY_CAPS.connectorRequest,
  );
  if (!parsed.ok) {
    if (parsed.reason === "too_large") return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const password = parsed.value?.password;
  const next = parsed.value?.next;

  if (typeof password !== "string") {
    if (trackable) recordFailure(ip);
    return NextResponse.json({ error: "missing password" }, { status: 400 });
  }

  // Constant-time compare via fixed-length SHA-256 digests.
  //
  // Audit 2026-06-03 (HIGH #2): the previous fixed-256-byte padding approach
  // SKIPPED the copy when an input exceeded 256 bytes (`if (b.length <= PAD)`),
  // leaving that buffer all-zeros. Two >256-byte inputs of equal length both
  // hashed to the all-zero buffer → any same-length payload authenticated
  // (practical for JWT-style tokens of 200-400 bytes).
  //
  // Hashing both sides to 32-byte digests is inherently constant-length:
  // timingSafeEqual always runs over equal-length buffers, there is no
  // truncation, and no length-equality short-circuit is needed (digest
  // collisions are infeasible). The expected password is identical every
  // request, so its hash time is constant — no secret length is leaked.
  // Audit 2026-05-17 (#600) timing concern remains addressed.
  const aHash = crypto.createHash("sha256").update(password, "utf8").digest();
  const bHash = crypto.createHash("sha256").update(expected, "utf8").digest();
  const equal = crypto.timingSafeEqual(aHash, bHash);

  if (!equal) {
    // Only track failures against a real, attributable client key. The
    // "unknown" bucket (no trusted proxy) must not accumulate a shared
    // lockout — see the trackable guard above.
    if (trackable) {
      const result = recordFailure(ip);
      if (result.locked) {
        return NextResponse.json(
          { error: "too many attempts" },
          {
            status: 429,
            headers: { "Retry-After": String(result.retryAfterSec) },
          },
        );
      }
    }
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  if (trackable) recordSuccess(ip);
  const cookie = await signSession();
  const redirect = isSafeRedirect(next) ? next : "/dashboard";
  return NextResponse.json(
    { ok: true, redirect },
    { headers: { "Set-Cookie": sessionCookieHeader(cookie) } },
  );
}
