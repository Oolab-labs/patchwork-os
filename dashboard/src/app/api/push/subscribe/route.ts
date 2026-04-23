import { NextRequest, NextResponse } from "next/server";
import { addSubscription } from "@/lib/pushStore";
import type { PushSubscription } from "web-push";

export async function POST(req: NextRequest) {
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
