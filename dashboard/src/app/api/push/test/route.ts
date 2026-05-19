import { NextResponse } from "next/server";
import webpush from "web-push";
import { getSubscriptions } from "@/lib/pushStore";
import { requireSameOrigin } from "@/lib/csrf";

const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? "";
const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";

export async function POST(req: Request) {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  if (!vapidPublicKey || !vapidPrivateKey) {
    return NextResponse.json({ error: "VAPID keys not configured" }, { status: 503 });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const subs = getSubscriptions();
  if (subs.length === 0) {
    return NextResponse.json({ error: "No subscriptions registered" }, { status: 404 });
  }

  const payload = JSON.stringify({
    toolName: "Bash",
    tier: "high",
    callId: "test-" + Date.now(),
    summary: "Test notification from Patchwork",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });

  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload)),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  // 404 / 410 = subscription is gone (browser unsubscribed, VAPID
  // rotated, push service evicted). Count separately so the UI can
  // distinguish a legitimate "nobody subscribed" failure from "all
  // subs are stale" — when invalid === total, the most likely cause
  // is a VAPID-key change since the existing subs were created.
  const invalid = results.filter((r) => {
    if (r.status !== "rejected") return false;
    const err = r.reason as { statusCode?: number } | null;
    return err?.statusCode === 404 || err?.statusCode === 410;
  }).length;
  return NextResponse.json({
    ok: true,
    sent,
    total: subs.length,
    invalid,
  });
}
