import crypto from "node:crypto";
import { NextResponse } from "next/server";
import webpush from "web-push";
import { getSubscriptions, removeSubscription } from "@/lib/pushStore";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";

/**
 * Bridge → dashboard push relay.
 *
 * The bridge POSTs here when an approval is queued, the same way it would
 * POST to a hosted FCM/APNS push-relay service (`services/push-relay/`).
 * Wire-shape matches that service so an operator can point
 * `pushServiceUrl` at this dashboard's URL instead of running a separate
 * relay process. Fan-out is via Web Push (VAPID) to every browser
 * subscription stored in `~/.claude/patchwork-push-subscriptions.json`.
 *
 * Auth: Bearer token compared timing-safe against `PATCHWORK_PUSH_TOKEN`.
 * The operator sets this env var on the dashboard AND configures the
 * bridge with the same value via `pushServiceToken`.
 *
 * Replay protection is intentionally NOT implemented here (v1). A
 * replayed push only re-fires a notification — the SW still validates the
 * one-shot `approvalToken` against the bridge, so a replay can't
 * double-approve. The push-relay service implements replay defense for
 * a different reason (per-user device flooding); we'd add it here later.
 */

// Env vars are read at REQUEST time (not module load) so test setup and
// dev-server HMR pick up changes without a process restart.
function readVapidConfig(): {
  publicKey: string;
  privateKey: string;
  subject: string;
} {
  return {
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
  };
}

interface RelayPushBody {
  callId?: string;
  toolName?: string;
  tier?: string;
  summary?: string;
  riskSignals?: unknown;
  approvalToken?: string;
  bridgeCallbackBase?: string;
  requestedAt?: number;
  expiresAt?: number;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function verifyBearer(req: Request): boolean {
  const expected = process.env.PATCHWORK_PUSH_TOKEN ?? "";
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = header.slice(7);
  // Pad BOTH to a fixed-size buffer so timingSafeEqual loop cost is
  // identical regardless of token length — length-equality check runs AFTER
  // (not before) to avoid leaking the expected token length via timing.
  // Mirrors the PAD=256 pattern in /api/login/route.ts (PR #600).
  const PAD = 256;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const pa = Buffer.alloc(PAD);
  const pb = Buffer.alloc(PAD);
  if (a.length <= PAD) a.copy(pa);
  if (b.length <= PAD) b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

export async function POST(req: Request) {
  if (!verifyBearer(req)) return unauthorized();

  const vapid = readVapidConfig();
  if (!vapid.publicKey || !vapid.privateKey) {
    return NextResponse.json(
      { error: "VAPID keys not configured" },
      { status: 503 },
    );
  }

  const parsed = await readJsonWithCap<RelayPushBody>(
    req,
    DASHBOARD_API_BODY_CAPS.relayPush,
  );
  if (!parsed.ok) {
    if (parsed.reason === "too_large")
      return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parsed.value;

  const { callId, toolName, tier, approvalToken, bridgeCallbackBase } = body;
  if (!callId || !toolName || !tier || !approvalToken) {
    return NextResponse.json(
      {
        error:
          "missing required fields: callId, toolName, tier, approvalToken",
      },
      { status: 400 },
    );
  }
  if (!bridgeCallbackBase || !bridgeCallbackBase.startsWith("https://")) {
    return NextResponse.json(
      { error: "bridgeCallbackBase must be HTTPS" },
      { status: 400 },
    );
  }

  const now = Date.now();
  if (typeof body.expiresAt === "number" && body.expiresAt < now) {
    return NextResponse.json(
      { error: "payload already expired" },
      { status: 400 },
    );
  }

  const subs = getSubscriptions();
  if (subs.length === 0) {
    // Bridge fires fire-and-forget so this 404 is informational only —
    // the ok:false form lets curl-based debugging see the empty state.
    return NextResponse.json(
      { ok: false, sent: 0, total: 0, error: "no subscriptions" },
      { status: 404 },
    );
  }

  // Construct the payload the SW expects. URL-construct (don't concat) so
  // a trailing slash on bridgeCallbackBase doesn't double up.
  const approveUrl = new URL(`/approve/${callId}`, bridgeCallbackBase).toString();
  const rejectUrl = new URL(`/reject/${callId}`, bridgeCallbackBase).toString();

  const payload = JSON.stringify({
    callId,
    toolName,
    tier,
    summary: body.summary,
    requestedAt: body.requestedAt ?? now,
    expiresAt: body.expiresAt ?? now + 5 * 60_000,
    approvalToken,
    approveUrl,
    rejectUrl,
  });

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload)),
  );
  const sent = results.filter((r) => r.status === "fulfilled").length;

  // Evict expired subscriptions. RFC 8030 mandates 404 / 410 when the
  // push service has no record of the subscription (uninstalled SW,
  // user disabled notifications, browser reset, device flashed). Pre-fix
  // we kept re-fanning to those endpoints forever — each request
  // carrying a live `approvalToken` to a service that no longer routes
  // it. Audit 2026-05-17.
  let evicted = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sub = subs[i];
    if (r.status !== "rejected" || !sub) continue;
    const status = extractPushStatusCode(r.reason);
    if (status === 404 || status === 410) {
      removeSubscription(sub.endpoint);
      evicted++;
    }
  }

  return NextResponse.json({ ok: true, sent, total: subs.length, evicted });
}

/**
 * Pluck the HTTP status code out of a web-push rejection. The library
 * throws `WebPushError` instances with a `statusCode` field. Older
 * versions of node-pushlib used `code`/`status`. Be defensive about
 * shape so a future bump doesn't silently break the eviction path.
 */
function extractPushStatusCode(reason: unknown): number | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  const r = reason as { statusCode?: unknown; status?: unknown };
  if (typeof r.statusCode === "number") return r.statusCode;
  if (typeof r.status === "number") return r.status;
  return undefined;
}
