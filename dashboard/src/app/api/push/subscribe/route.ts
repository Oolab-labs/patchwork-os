import { NextRequest, NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/csrf";
import { validatePushEndpoint } from "@/lib/pushEndpoint";
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

  // The endpoint is a URL this server will later POST to on every relay
  // fan-out. Only an https URL on a public host is a push service; anything
  // else is a request to make the dashboard reach into the network for the
  // caller (security sweep 2026-10-01, L2). The reason never echoes the URL.
  const verdict = validatePushEndpoint(sub.endpoint);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  // The store is capped; a NEW endpoint past the cap is refused rather than
  // evicting someone else's device. Re-subscribes of a known endpoint always
  // succeed (pushsubscriptionchange).
  if (!addSubscription(sub)) {
    return NextResponse.json(
      { error: "subscription limit reached — remove an old device first" },
      { status: 429 },
    );
  }
  return NextResponse.json({ ok: true });
}
