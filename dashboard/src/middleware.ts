import { NextRequest, NextResponse } from "next/server";
import {
  checkLocked,
  recordFailure,
  recordSuccess,
} from "@/lib/authRateLimit";
import { clientKey } from "@/lib/clientIp";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const ALLOW_UNAUTHENTICATED =
  process.env.DASHBOARD_ALLOW_UNAUTHENTICATED === "1";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

// Constant-time string comparison. Length difference is folded into the
// final XOR so a length-only timing leak doesn't bypass the loop.
function constantTimeEq(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function lockedResponse(retryAfterSec: number): NextResponse {
  return new NextResponse("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(retryAfterSec) },
  });
}

export function middleware(req: NextRequest) {
  if (DEMO_MODE) {
    return NextResponse.next();
  }

  if (!DASHBOARD_PASSWORD) {
    if (process.env.NODE_ENV === "production" && !ALLOW_UNAUTHENTICATED) {
      return new NextResponse(
        "Dashboard auth not configured. Set DASHBOARD_PASSWORD or DASHBOARD_ALLOW_UNAUTHENTICATED=1.",
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  const ip = clientKey(req.headers);

  // Check lockout BEFORE inspecting credentials so a locked-out client
  // can't keep probing.
  const lock = checkLocked(ip);
  if (lock.locked) return lockedResponse(lock.retryAfterSec);

  const auth = req.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      const password = colonIdx !== -1 ? decoded.slice(colonIdx + 1) : "";
      if (constantTimeEq(password, DASHBOARD_PASSWORD)) {
        recordSuccess(ip);
        return NextResponse.next();
      }
    }
  }

  const result = recordFailure(ip);
  if (result.locked) return lockedResponse(result.retryAfterSec);

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Patchwork OS", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: [
    // Protect all routes except Next.js internals, public assets, marketplace,
    // and the bridge-relay endpoint.
    //
    // `api/relay/push` is exempted because it's the bridge → dashboard push
    // handshake — it has its own Bearer-token auth (PATCHWORK_PUSH_TOKEN,
    // timing-safe). Routing it through this Basic-auth middleware would
    // make the bridge's outbound POST fail with 401 if the operator ever
    // sets DASHBOARD_PASSWORD, silently breaking phone notifications for
    // every queued approval.
    //
    // Includes favicon.svg + manifest.json + robots.txt so PWA / browser asset
    // requests don't 401 on every page load.
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|manifest\\.json|robots\\.txt|schema/|marketplace|api/relay/push).*)",
  ],
};
