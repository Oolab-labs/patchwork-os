import { NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import { bodyTooLargeResponse, readJsonWithCap } from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";

// Small cap — telemetry prefs payload is a tiny boolean envelope.
const TELEMETRY_PREFS_CAP = 4096;

export async function GET() {
  try {
    const res = await bridgeFetch("/telemetry-prefs");
    if (!res.ok) {
      // #600: don't leak upstream body — log server-side, return generic.
      const text = await res.text().catch(() => "");
      console.error(
        `[bridge/telemetry-prefs GET] bridge returned ${res.status}:`,
        text,
      );
      return NextResponse.json(
        { error: `Bridge returned ${res.status}` },
        { status: res.status },
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error("[bridge/telemetry-prefs GET] bridge fetch failed:", err);
    return NextResponse.json(
      { error: "Bridge unreachable" },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const guard = requireSameOrigin(request);
  if (guard) return guard;
  const parsed = await readJsonWithCap<unknown>(request, TELEMETRY_PREFS_CAP);
  if (!parsed.ok) {
    if (parsed.reason === "too_large") return bodyTooLargeResponse(parsed.maxBytes);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parsed.value ?? {};
  try {
    const res = await bridgeFetch("/telemetry-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[bridge/telemetry-prefs POST] bridge returned ${res.status}:`,
        text,
      );
      return NextResponse.json(
        { error: `Bridge returned ${res.status}` },
        { status: res.status },
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[bridge/telemetry-prefs POST] bridge fetch failed:", err);
    return NextResponse.json(
      { error: "Bridge unreachable" },
      { status: 502 },
    );
  }
}
