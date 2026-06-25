import { NextResponse } from "next/server";
import webpush from "web-push";
import { verifyBearerToken } from "@/lib/constantTimeEqual";
import { getSubscriptionsFor, removeSubscription } from "@/lib/pushStore";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";

/**
 * Bridge → dashboard halt-event relay.
 *
 * Sibling of /api/relay/push (approval-call relay). The bridge POSTs
 * here whenever a recipe transitions to a terminal failure state
 * (halted / errored). The route fans out a Web Push notification to
 * every subscription that opted in to halt events via
 * `pushStore` prefs.
 *
 * Wire-shape matches the approval relay so an operator can point a
 * single `pushServiceUrl` at the dashboard and have it serve both:
 *   POST /api/relay/push  — approvals
 *   POST /api/relay/halt  — halts
 *
 * Auth: Bearer token compared timing-safe against PATCHWORK_PUSH_TOKEN
 * (shared with the approval relay).
 */

function readVapidConfig(): { publicKey: string; privateKey: string; subject: string } {
  return {
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
  };
}

interface RelayHaltBody {
  recipeName?: string;
  runSeq?: number;
  status?: "halted" | "error";
  haltReason?: string;
  haltCategory?: string;
  /** Actionable fix hint (rendered by the bridge from HALT_CATEGORY_HINTS) —
   *  forwarded verbatim so the service worker can show "what to do". */
  actionHint?: string;
  stepId?: string;
  errorMessage?: string;
  occurredAt?: number;
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

  const parsed = await readJsonWithCap<RelayHaltBody>(
    req,
    DASHBOARD_API_BODY_CAPS.relayHalt,
  );
  if (!parsed.ok) {
    if (parsed.reason === "too_large")
      return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parsed.value;

  const { recipeName, runSeq, status } = body;
  if (!recipeName || typeof runSeq !== "number" || !status) {
    return NextResponse.json(
      { error: "missing required fields: recipeName, runSeq, status" },
      { status: 400 },
    );
  }
  if (status !== "halted" && status !== "error") {
    return NextResponse.json(
      { error: "status must be 'halted' or 'error'" },
      { status: 400 },
    );
  }

  const subs = getSubscriptionsFor("halts");
  if (subs.length === 0) {
    // Bridge fires fire-and-forget so this 404 is informational only.
    return NextResponse.json(
      { ok: false, sent: 0, total: 0, error: "no halt subscribers" },
      { status: 404 },
    );
  }

  const now = Date.now();
  const payload = JSON.stringify({
    kind: "halt",
    recipeName,
    runSeq,
    status,
    haltReason: body.haltReason,
    haltCategory: body.haltCategory,
    actionHint: body.actionHint,
    stepId: body.stepId,
    errorMessage: body.errorMessage,
    occurredAt: body.occurredAt ?? now,
  });

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload)),
  );
  const sent = results.filter((r) => r.status === "fulfilled").length;

  // Same 404/410 eviction logic as /api/relay/push — RFC 8030 endpoint
  // teardown. Without it we keep fanning forever to dead subscriptions.
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

function extractPushStatusCode(reason: unknown): number | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  const r = reason as { statusCode?: unknown; status?: unknown };
  if (typeof r.statusCode === "number") return r.statusCode;
  if (typeof r.status === "number") return r.status;
  return undefined;
}
