/**
 * Simple mode lands on Butler, not the Overview deck.
 *
 * Butler is the large-print, single-column, accessibility-led page; Overview is
 * the densest screen in the product. Someone who picks Simple mode has said
 * they want less — so the deck is the wrong first thing to show them.
 *
 * The subtlety these tests pin: only a FRESH landing redirects. An in-app click
 * carries a same-origin referer and must NOT bounce, or Overview becomes
 * unreachable in Simple mode — taking the FirstRun onboarding funnel with it,
 * which lives on that page and matters most to exactly the non-technical users
 * Simple mode exists for.
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { NAV_MODE_COOKIE } from "@/middleware";

function req(
  path: string,
  opts: { mode?: string; referer?: string; method?: string } = {},
): NextRequest {
  const r = new NextRequest(new URL(`http://localhost:3000${path}`), {
    method: opts.method ?? "GET",
  });
  if (opts.mode) r.cookies.set(NAV_MODE_COOKIE, opts.mode);
  if (opts.referer) r.headers.set("referer", opts.referer);
  return r;
}

// Re-implemented here only to assert the CONTRACT; the real function is not
// exported (it is internal to the middleware chain). Kept byte-aligned with it.
async function landing(r: NextRequest): Promise<string | null> {
  const { butlerLandingForTest } = await import("@/middleware");
  const res = butlerLandingForTest(r);
  return res ? (res.headers.get("location") ?? "") : null;
}

describe("Butler landing (Simple mode)", () => {
  it("redirects a fresh landing on / to /butler", async () => {
    expect(await landing(req("/", { mode: "simple" }))).toContain("/butler");
  });

  it("leaves Advanced mode alone", async () => {
    expect(await landing(req("/", { mode: "advanced" }))).toBeNull();
  });

  it("leaves a browser with no mode cookie alone", async () => {
    // Degrades to today's behaviour rather than guessing.
    expect(await landing(req("/"))).toBeNull();
  });

  it("does NOT bounce an in-app click to Overview", async () => {
    // The whole reason for the referer check. Without it, Overview — and the
    // onboarding funnel on it — would be unreachable in Simple mode.
    expect(
      await landing(
        req("/", { mode: "simple", referer: "http://localhost:3000/recipes" }),
      ),
    ).toBeNull();
  });

  it("treats a cross-origin referer as a fresh landing", async () => {
    expect(
      await landing(
        req("/", { mode: "simple", referer: "https://mail.example.com/" }),
      ),
    ).toContain("/butler");
  });

  it("only touches the root path", async () => {
    expect(await landing(req("/recipes", { mode: "simple" }))).toBeNull();
  });

  it("ignores non-GET requests", async () => {
    expect(
      await landing(req("/", { mode: "simple", method: "POST" })),
    ).toBeNull();
  });
});
