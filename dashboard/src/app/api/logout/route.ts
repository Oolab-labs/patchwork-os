import { NextResponse } from "next/server";
import { clearSessionCookieHeader } from "@/lib/session";

/**
 * Clear the dashboard session cookie. Returns the user to the login page.
 * POST only so a hostile cross-site form can't log the user out (though
 * Same-Site=Strict on the cookie already covers that — belt + braces).
 */
export async function POST() {
  return NextResponse.json(
    { ok: true, redirect: "/dashboard/login" },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } },
  );
}
