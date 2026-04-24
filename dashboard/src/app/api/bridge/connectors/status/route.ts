import { bridgeFetch } from "@/lib/bridge";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
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
