import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  checkGlobalLocked,
  checkLocked,
  recordFailure,
  recordGlobalFailure,
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
  // literal "unknown" for EVERY request. A per-IP lockout keyed on "unknown"
  // would lock out ALL users after MAX_FAILURES bad passwords. Instead, use a
  // global fallback bucket with a much higher threshold
  // (DASHBOARD_AUTH_GLOBAL_MAX_FAILURES, default 50) — still bounds automated
  // attacks while legitimate users making a few typos are never denied.
  // Audit 2026-06-03 MEDIUM #18.
  const trackable = ip !== "unknown";
  if (trackable) {
    const lock = checkLocked(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: "too many attempts" },
        { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } },
      );
    }
  } else {
    const lock = checkGlobalLocked();
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

  // Constant-time equality of two secrets via a fixed-length padded compare.
  //
  // Audit 2026-06-03 (HIGH #2): the previous version padded into a 256-byte
  // buffer but SKIPPED the copy when an input exceeded 256 bytes
  // (`if (b.length <= PAD)`), leaving that buffer all-zeros — so two >256-byte
  // inputs of equal length both compared as all-zeros and any same-length
  // payload authenticated (practical for JWT-style tokens of 200-400 bytes).
  //
  // Fix: always copy up to a fixed CAP into equal-sized buffers (Buffer.copy
  // bounds at min(src.length, CAP), so no overflow and — for accepted inputs —
  // no all-zero collision), reject inputs longer than CAP, and run
  // timingSafeEqual over the full CAP every call. The byte comparison happens
  // FIRST; the length/cap checks are ANDed AFTER (never short-circuited before
  // timingSafeEqual), preserving the Audit 2026-05-17 (#600) property that
  // response time does not leak the expected password's length.
  //
  // This is a plain equality check (single shared secret from env), NOT
  // password-at-rest hashing — deliberately no hash/KDF in the data path.
  const CAP = 1024; // generous upper bound for a shared dashboard password
  const ab = Buffer.from(password, "utf8");
  const eb = Buffer.from(expected, "utf8");
  const pa = Buffer.alloc(CAP);
  const pb = Buffer.alloc(CAP);
  ab.copy(pa, 0, 0, CAP);
  eb.copy(pb, 0, 0, CAP);
  const bytesEqual = crypto.timingSafeEqual(pa, pb);
  const equal =
    bytesEqual &&
    ab.length === eb.length &&
    ab.length <= CAP &&
    eb.length <= CAP;

  if (!equal) {
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
    } else {
      const result = recordGlobalFailure();
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
