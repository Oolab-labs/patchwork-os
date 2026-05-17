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
  const lock = checkLocked(ip);
  if (lock.locked) {
    return NextResponse.json(
      { error: "too many attempts" },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } },
    );
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
    recordFailure(ip);
    return NextResponse.json({ error: "missing password" }, { status: 400 });
  }

  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Constant-time compare. Pad BOTH inputs to the same fixed buffer
  // (PAD = 256) every call so the loop cost is identical regardless of
  // either input's length, then AND with a length-equality check that
  // runs AFTER timingSafeEqual (not before — short-circuiting on
  // length is the same leak as not padding at all).
  // Audit 2026-05-17 (#600): previous version padded to
  // `max(a.length, b.length)` and short-circuited on `a.length ===
  // b.length` BEFORE timingSafeEqual, leaking expected-password length
  // via response time.
  const PAD = 256;
  const pa = Buffer.alloc(PAD);
  const pb = Buffer.alloc(PAD);
  if (a.length <= PAD) a.copy(pa);
  if (b.length <= PAD) b.copy(pb);
  const bytesEqual = crypto.timingSafeEqual(pa, pb);
  const equal = bytesEqual && a.length === b.length;

  if (!equal) {
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
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  recordSuccess(ip);
  const cookie = await signSession();
  const redirect = isSafeRedirect(next) ? next : "/dashboard";
  return NextResponse.json(
    { ok: true, redirect },
    { headers: { "Set-Cookie": sessionCookieHeader(cookie) } },
  );
}
