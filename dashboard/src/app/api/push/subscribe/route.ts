import { NextRequest, NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/csrf";
import { addSubscription } from "@/lib/pushStore";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";
import type { PushSubscription } from "web-push";

export async function POST(req: NextRequest) {
  const guard = requireSameOrigin(req);
  if (guard) return guard;

  // Audit 2026-05-17 (#600 BLOCKER #4): the route was exempt from the
  // middleware session gate to let the SW re-subscribe via
  // pushsubscriptionchange, but SW fetches default to
  // credentials: "same-origin" and DO carry the session cookie. The
  // exemption left an unauthenticated addSubscription that any visitor
  // (or attacker faking Origin) could spam, polluting the push store.
  // Re-protect at the handler layer and trim the middleware exempt
  // list to match.
  const session = await verifySession(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session.valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJsonWithCap<unknown>(req, DASHBOARD_API_BODY_CAPS.push);
  if (!parsed.ok) {
    if (parsed.reason === "too_large") return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sub = parsed.value as PushSubscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json({ error: "Invalid subscription object" }, { status: 400 });
  }

  addSubscription(sub);
  return NextResponse.json({ ok: true });
}
