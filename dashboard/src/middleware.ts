import { NextRequest, NextResponse } from "next/server";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

export function middleware(req: NextRequest) {
  // Skip auth if no password configured (local dev)
  if (!DASHBOARD_PASSWORD) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      const password = colonIdx !== -1 ? decoded.slice(colonIdx + 1) : "";
      if (password === DASHBOARD_PASSWORD) return NextResponse.next();
    }
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Patchwork OS", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: [
    // Protect all routes except Next.js internals, public schema files, and marketplace
    "/((?!_next/static|_next/image|favicon.ico|schema/|marketplace).*)",
  ],
};
