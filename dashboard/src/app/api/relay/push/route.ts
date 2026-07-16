import { NextResponse } from "next/server";
import webpush from "web-push";
import { verifyBearerToken } from "@/lib/constantTimeEqual";
import { pushAgent } from "@/lib/pushAgent";
import { getSubscriptionsFor, removeSubscription } from "@/lib/pushStore";
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
  kind?: "cancel";
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
  // Shared constant-time compare (src/lib/constantTimeEqual.ts) — see that
  // file for the all-zeros-collision bug this avoids (audit 2026-06-08).
  return verifyBearerToken(req, process.env.PATCHWORK_PUSH_TOKEN ?? "");
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

  // Cancel pushes only need a callId — they tell the SW to close a
  // previously-shown "tap to approve" notification by tag, not to show a
  // new one, so none of the approve/reject wiring below applies.
  if (body.kind === "cancel") {
    if (!body.callId) {
      return NextResponse.json(
        { error: "missing required field: callId" },
        { status: 400 },
      );
    }
    const subs = getSubscriptionsFor("approvals");
    if (subs.length === 0) {
      return NextResponse.json(
        { ok: false, sent: 0, total: 0, error: "no approval subscribers" },
        { status: 404 },
      );
    }
    const cancelPayload = JSON.stringify({
      kind: "cancel",
      callId: body.callId,
    });
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(sub, cancelPayload, { agent: pushAgent }),
      ),
    );
    const sent = results.filter((r) => r.status === "fulfilled").length;
    return NextResponse.json({ ok: true, sent, total: subs.length });
  }

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
  // Audit 2026-06-03 MEDIUM #19: startsWith("https://") passes for the bare
  // string "https://" (no hostname), but new URL("/path", "https://") throws
  // TypeError. Validate with the URL constructor to catch this case.
  let callbackBase: URL;
  try {
    callbackBase = new URL(bridgeCallbackBase as string);
  } catch {
    return NextResponse.json(
      { error: "bridgeCallbackBase must be a valid HTTPS URL" },
      { status: 400 },
    );
  }
  if (callbackBase.protocol !== "https:") {
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

  // Filter to subscriptions opted in to approval pushes. A user who set
  // approvals:false via /api/push/prefs must NOT receive these — pre-fix
  // this used the unfiltered getSubscriptions() and ignored the opt-out
  // (the halt relay already filtered via getSubscriptionsFor("halts")).
  const subs = getSubscriptionsFor("approvals");
  if (subs.length === 0) {
    // Bridge fires fire-and-forget so this 404 is informational only —
    // the ok:false form lets curl-based debugging see the empty state.
    return NextResponse.json(
      { ok: false, sent: 0, total: 0, error: "no approval subscribers" },
      { status: 404 },
    );
  }

  // Construct the payload the SW expects. URL-construct (don't concat) so
  // a trailing slash on bridgeCallbackBase doesn't double up.
  const approveUrl = new URL(`/approve/${callId}`, callbackBase).toString();
  const rejectUrl = new URL(`/reject/${callId}`, callbackBase).toString();

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
    subs.map((sub) =>
      webpush.sendNotification(sub, payload, {
        agent: pushAgent,
        urgency: "high",
      }),
    ),
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
