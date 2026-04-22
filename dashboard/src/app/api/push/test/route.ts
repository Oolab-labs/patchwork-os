import { NextResponse } from "next/server";

const RELAY_URL = process.env.PUSH_RELAY_URL;
const RELAY_TOKEN = process.env.PUSH_RELAY_TOKEN;

export async function POST() {
  if (!RELAY_URL || !RELAY_TOKEN) {
    return NextResponse.json({ error: "Push relay not configured" }, { status: 503 });
  }

  try {
    const res = await fetch(`${RELAY_URL}/push/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RELAY_TOKEN}`,
      },
      body: "{}",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
