import { NextRequest, NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/csrf";
import { addSubscription } from "@/lib/pushStore";
import type { PushSubscription } from "web-push";

export async function POST(req: NextRequest) {
  const guard = requireSameOrigin(req);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sub = body as PushSubscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json({ error: "Invalid subscription object" }, { status: 400 });
  }

  addSubscription(sub);
  return NextResponse.json({ ok: true });
}
