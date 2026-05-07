import { NextRequest, NextResponse } from "next/server";
import { removeSubscription } from "@/lib/pushStore";
import { requireSameOrigin } from "@/lib/csrf";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";

export async function POST(req: NextRequest) {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
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
