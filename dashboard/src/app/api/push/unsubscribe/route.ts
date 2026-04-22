import { NextRequest, NextResponse } from "next/server";

const RELAY_URL = process.env.PUSH_RELAY_URL;
const RELAY_TOKEN = process.env.PUSH_RELAY_TOKEN;

export async function POST(req: NextRequest) {
  if (!RELAY_URL || !RELAY_TOKEN) {
    return NextResponse.json({ error: "Push relay not configured" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = body.endpoint ? JSON.stringify(body) : String(body.token ?? "");
  if (!token) {
    return NextResponse.json({ error: "token or endpoint required" }, { status: 400 });
  }

  // URL-encode the token to use as path segment (it may contain /)
  const encoded = encodeURIComponent(token);
  try {
    const res = await fetch(`${RELAY_URL}/devices/${encoded}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text }, { status: res.status });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
