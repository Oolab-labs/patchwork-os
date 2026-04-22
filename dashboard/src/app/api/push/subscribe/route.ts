import { NextRequest, NextResponse } from "next/server";

const RELAY_URL = process.env.PUSH_RELAY_URL;
const RELAY_TOKEN = process.env.PUSH_RELAY_TOKEN;

export async function POST(req: NextRequest) {
  if (!RELAY_URL || !RELAY_TOKEN) {
    return NextResponse.json({ error: "Push relay not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Forward the Web Push subscription object + platform tag to the relay
  const platform = (body as Record<string, unknown>).platform ?? "web-push";

  try {
    const res = await fetch(`${RELAY_URL}/devices/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RELAY_TOKEN}`,
      },
      body: JSON.stringify({
        token: JSON.stringify(body), // relay stores opaque token string
        platform,
      }),
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
