import { NextRequest, NextResponse } from "next/server";
import { removeSubscription } from "@/lib/pushStore";
import { requireSameOrigin } from "@/lib/csrf";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const guard = requireSameOrigin(req);
  if (guard) return guard;

  // Audit 2026-05-17 (#600 BLOCKER #4): unauthenticated unsubscribe
  // would let an attacker silently de-register real devices. Same
  // exemption story as subscribe — see that file.
  const session = await verifySession(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session.valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJsonWithCap<Record<string, unknown>>(
    req,
    DASHBOARD_API_BODY_CAPS.push,
  );
  if (!parsed.ok) {
    if (parsed.reason === "too_large") return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parsed.value ?? {};

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  }

  removeSubscription(endpoint);
  return NextResponse.json({ ok: true });
}
