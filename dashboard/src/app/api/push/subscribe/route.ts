import { NextRequest, NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/csrf";
import { addSubscription } from "@/lib/pushStore";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";
import type { PushSubscription } from "web-push";

export async function POST(req: NextRequest) {
  const guard = requireSameOrigin(req);
  if (guard) return guard;

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
