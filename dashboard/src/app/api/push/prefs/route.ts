import { NextRequest, NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/csrf";
import { getPrefs, setPrefs } from "@/lib/pushStore";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";

/**
 * Per-subscription push preferences.
 *
 *   GET  /api/push/prefs?endpoint=<url>  → { prefs: { approvals, halts } }
 *   POST /api/push/prefs { endpoint, halts? , approvals? } → { ok, prefs }
 *
 * Same auth posture as /api/push/subscribe — same-origin + session.
 * Unknown endpoints: GET returns the defaults; POST 404s (you can't
 * set prefs for a subscription that was never registered).
 */

async function authed(req: NextRequest): Promise<NextResponse | null> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const session = await verifySession(
    req.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!session.valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const fail = await authed(req);
  if (fail) return fail;

  const endpoint = req.nextUrl.searchParams.get("endpoint");
  if (!endpoint) {
    return NextResponse.json(
      { error: "endpoint query param required" },
      { status: 400 },
    );
  }
  return NextResponse.json({ prefs: getPrefs(endpoint) });
}

export async function POST(req: NextRequest) {
  const fail = await authed(req);
  if (fail) return fail;

  const parsed = await readJsonWithCap<{
    endpoint?: string;
    halts?: boolean;
    approvals?: boolean;
  }>(req, DASHBOARD_API_BODY_CAPS.push);
  if (!parsed.ok) {
    if (parsed.reason === "too_large")
      return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parsed.value;
  if (!body?.endpoint) {
    return NextResponse.json(
      { error: "endpoint required" },
      { status: 400 },
    );
  }

  const next: { halts?: boolean; approvals?: boolean } = {};
  if (typeof body.halts === "boolean") next.halts = body.halts;
  if (typeof body.approvals === "boolean") next.approvals = body.approvals;
  if (Object.keys(next).length === 0) {
    return NextResponse.json(
      { error: "no preference fields to update" },
      { status: 400 },
    );
  }

  const ok = setPrefs(body.endpoint, next);
  if (!ok) {
    return NextResponse.json(
      { error: "unknown subscription endpoint" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, prefs: getPrefs(body.endpoint) });
}
