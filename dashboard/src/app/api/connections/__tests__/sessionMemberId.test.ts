/**
 * `sessionMemberId` — the read side of ADR-0020 Phase A attribution.
 *
 * Closes the loop the login route opens: a v2 cookie minted for a member must
 * read back AS that member, and everything else must read back as nobody.
 * "Everything else" is the part worth pinning — an unattributed session that
 * resolved to some stand-in person would turn the absence of a subject into a
 * claim about one, which is the failure this ADR exists to prevent.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { sessionMemberId } from "../requireSession";
import { SESSION_COOKIE_NAME, signSession } from "@/lib/session";

function withCookie(value?: string): Request {
  return new Request("https://dash.example.test/api/anything", {
    headers: value ? { cookie: `${SESSION_COOKIE_NAME}=${value}` } : {},
  });
}

beforeEach(() => {
  process.env.DASHBOARD_SESSION_SECRET = "b".repeat(48);
});

describe("sessionMemberId", () => {
  it("names the member carried by a v2 cookie", async () => {
    const cookie = await signSession({ memberId: "ada" });
    expect(await sessionMemberId(withCookie(cookie))).toBe("ada");
  });

  it("is undefined for a v1 cookie — valid, but nobody was identified", async () => {
    const cookie = await signSession();
    // The session IS valid; that is exactly why this must not be a person.
    expect(await sessionMemberId(withCookie(cookie))).toBeUndefined();
  });

  it("is undefined with no cookie at all", async () => {
    expect(await sessionMemberId(withCookie())).toBeUndefined();
  });

  it("is undefined for a forged subject", async () => {
    // A v2-shaped cookie nobody signed. If this returned "root" the header
    // would be an identity anyone could assert.
    expect(
      await sessionMemberId(withCookie("v2.root.99999999999999.notasignature")),
    ).toBeUndefined();
  });

  it("is undefined for an expired cookie that names a member", async () => {
    const cookie = await signSession({ memberId: "ada", expiresAt: Date.now() - 1000 });
    expect(await sessionMemberId(withCookie(cookie))).toBeUndefined();
  });
});
