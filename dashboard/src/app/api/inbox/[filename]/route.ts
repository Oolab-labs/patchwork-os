import { bridgeFetch } from "@/lib/bridge";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  try {
    const res = await bridgeFetch(`/inbox/${encodeURIComponent(filename)}`);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error("[inbox/:filename GET] bridge fetch failed:", err);
    return NextResponse.json(
      { error: "Bridge unreachable" },
      { status: 502 },
    );
  }
}
