import { NextRequest, NextResponse } from "next/server";
import { removeSubscription } from "@/lib/pushStore";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  }

  removeSubscription(endpoint);
  return NextResponse.json({ ok: true });
}
