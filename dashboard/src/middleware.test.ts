import { describe, expect, it } from "vitest";
import { SESSION_GATE_MATCHER } from "./middleware";

/**
 * Next.js consumes `config.matcher` at build time to decide which request
 * paths the middleware runs on — the negative-lookahead is NOT evaluated
 * inside `middleware()` itself. So the way to assert the OAuth-callback
 * exemption is to compile the matcher string the same way Next does
 * (anchored, full-path) and check which concrete paths it matches.
 *
 * A path that MATCHES → middleware runs → (no session) → 302 to /login.
 * A path that does NOT match → middleware is skipped → request passes
 * through with its OAuth `code`/`state` intact.
 *
 * Note: Next.js strips `basePath` before matching, so the internal pathname
 * for the external `/dashboard/connections/github/callback` is
 * `/connections/github/callback`.
 */
function matcherRunsOn(pathname: string): boolean {
  // Mirror Next.js: each matcher entry is anchored as a full-path regex.
  const re = new RegExp(`^${SESSION_GATE_MATCHER}$`);
  return re.test(pathname);
}

describe("dashboard middleware session-gate matcher", () => {
  it("does NOT run on OAuth callback page routes (cross-site redirect, no cookie)", () => {
    // The bug: provider redirects browser to the callback as a cross-site
    // top-level nav, SameSite=Strict cookie is dropped, and the old matcher
    // ran the gate → 302 to /login → OAuth code/state lost.
    expect(matcherRunsOn("/connections/github/callback")).toBe(false);
  });

  it("exempts callbacks for hyphenated connector names", () => {
    // `[^/]+` must span a single segment including hyphens.
    expect(matcherRunsOn("/connections/google-calendar/callback")).toBe(false);
    expect(matcherRunsOn("/connections/google-drive/callback")).toBe(false);
  });

  it("exempts every shipped OAuth callback route", () => {
    const connectors = [
      "github",
      "slack",
      "gmail",
      "asana",
      "discord",
      "gitlab",
      "linear",
      "sentry",
      "google-calendar",
      "google-drive",
    ];
    for (const c of connectors) {
      expect(matcherRunsOn(`/connections/${c}/callback`)).toBe(false);
    }
  });

  it("exempts the same-origin callback API route (defense-in-depth)", () => {
    expect(matcherRunsOn("/api/connections/github/callback")).toBe(false);
  });

  it("STILL runs on the connections list page and connection detail pages", () => {
    // The exemption must be narrow: only `.../callback`, not the whole
    // connections area, which holds tokens and must stay gated.
    expect(matcherRunsOn("/connections")).toBe(true);
    expect(matcherRunsOn("/connections/github")).toBe(true);
  });

  it("still gates ordinary pages and mutating API routes", () => {
    expect(matcherRunsOn("/analytics")).toBe(true);
    expect(matcherRunsOn("/recipes")).toBe(true);
    expect(matcherRunsOn("/api/push/subscribe")).toBe(true);
    expect(matcherRunsOn("/api/logout")).toBe(true);
  });

  it("keeps the pre-existing public exemptions intact", () => {
    expect(matcherRunsOn("/api/login")).toBe(false);
    expect(matcherRunsOn("/sw.js")).toBe(false);
    expect(matcherRunsOn("/marketplace")).toBe(false);
    expect(matcherRunsOn("/api/relay/push")).toBe(false);
    expect(matcherRunsOn("/api/relay/halt")).toBe(false);
    expect(matcherRunsOn("/api/push/vapid-key")).toBe(false);
  });
});
