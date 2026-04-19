import { bridgeFetch } from "@/lib/bridge";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const res = await bridgeFetch("/inbox");
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
