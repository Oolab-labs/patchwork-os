import { NextRequest, NextResponse } from "next/server";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const ALLOW_UNAUTHENTICATED =
  process.env.DASHBOARD_ALLOW_UNAUTHENTICATED === "1";

export function middleware(req: NextRequest) {
  // No password configured.
  if (!DASHBOARD_PASSWORD) {
    // In dev, default to open access. In production, refuse to expose
    // the bridge proxy unless the operator opts in via
    // DASHBOARD_ALLOW_UNAUTHENTICATED=1 (e.g. behind a reverse proxy
    // that handles auth).
    if (process.env.NODE_ENV === "production" && !ALLOW_UNAUTHENTICATED) {
      return new NextResponse(
        "Dashboard auth not configured. Set DASHBOARD_PASSWORD or DASHBOARD_ALLOW_UNAUTHENTICATED=1.",
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

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
    // Protect all routes except Next.js internals, public assets, and marketplace.
    // Includes favicon.svg + manifest.json + robots.txt so PWA / browser asset
    // requests don't 401 on every page load.
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|manifest\\.json|robots\\.txt|schema/|marketplace).*)",
  ],
};
