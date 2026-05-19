import { bridgeFetch } from "@/lib/bridge";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await bridgeFetch("/connections");
    if (!res.ok) {
      // #600: don't leak upstream body — log server-side, return generic.
      const text = await res.text().catch(() => "");
      console.error(
        `[bridge/connectors/status] bridge returned ${res.status}:`,
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
    console.error("[bridge/connectors/status] bridge fetch failed:", err);
    return NextResponse.json(
      { error: "Bridge unreachable" },
      { status: 502 },
    );
  }
}
