import { bridgeFetch } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";
import { mockBridgeResponse } from "@/lib/mockData";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemoModeServer()) {
    const mock = mockBridgeResponse("/connectors/status", "GET");
    if (mock) return mock;
  }
  const res = await bridgeFetch("/connections");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: text || `Bridge returned ${res.status}` },
      { status: res.status },
    );
  }
  const data = await res.json();
  return NextResponse.json(data);
}
