import { bridgeFetch } from "@/lib/bridge";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  const res = await bridgeFetch(`/inbox/${encodeURIComponent(filename)}`);
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
