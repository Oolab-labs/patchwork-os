import { bridgeFetch } from "@/lib/bridge";
import { forwardOrGeneric } from "@/lib/forwardOrGeneric";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await bridgeFetch("/inbox");
    return await forwardOrGeneric(res, "inbox GET");
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error("[inbox GET] bridge fetch failed:", err);
    return NextResponse.json(
      { error: "Bridge unreachable" },
      { status: 502 },
    );
  }
}
