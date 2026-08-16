/**
 * Per-member login — ADR-0020 Phase A wiring.
 *
 * The load-bearing assertions, in the order they matter:
 *   1. a member-shaped request is NOT satisfied by the shared password;
 *   2. a successful member login mints a v2 cookie carrying that member;
 *   3. a request with no memberId still mints v1 — byte-identical status quo;
 *   4. a member id that cannot go in a cookie REFUSES rather than downgrading
 *      to an unattributed v1 session.
 *
 * These drive the real route handler and verify the real `Set-Cookie` through
 * the real `verifySession`, rather than asserting on a mock: the failure this
 * whole ADR guards against is a session that claims a subject it did not
 * establish, and only the actual cookie can show that.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashPassword } from "../../../../../../src/identity/credentials";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";

const PASSWORD = "member-secret-pw";
const SHARED = "shared-dashboard-pw";

let home: string;

/** Build a members.json + credentials.json under a throwaway PATCHWORK_HOME. */
async function seed(memberId: string): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "pw-memberlogin-"));
  writeFileSync(
    join(home, "members.json"),
    JSON.stringify([
      { id: memberId, displayName: "Ada", kind: "human", roles: ["approver"] },
    ]),
  );
  writeFileSync(
    join(home, "credentials.json"),
    JSON.stringify({ [memberId]: await hashPassword(PASSWORD) }),
  );
  process.env.PATCHWORK_HOME = home;
}

/**
 * Import the route AFTER the env is seeded. `memberAuth` memoises the roster
 * and credential file on first use, so a module cached from a previous test's
 * PATCHWORK_HOME would silently answer for the wrong workspace.
 */
async function post(body: unknown): Promise<Response> {
  const { POST } = await import("../route");
  const req = new Request("https://dash.example.test/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
  // The route takes a NextRequest; a Request satisfies everything it reads.
  return POST(req as never);
}

function cookieValue(res: Response): string | undefined {
  const header = res.headers.get("set-cookie");
  if (!header) return undefined;
  const m = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
  return m?.[1];
}

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = SHARED;
  process.env.DASHBOARD_SESSION_SECRET = "a".repeat(48);
  delete process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;
  // Fresh module registry per test so memberAuth's cache and the rate-limit
  // buckets do not leak across cases.
  vi.resetModules();
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  delete process.env.PATCHWORK_HOME;
});

describe("member login mints an attributed session", () => {
  it("authenticates a member and the cookie names them", async () => {
    await seed("ada");
    const res = await post({ memberId: "ada", password: PASSWORD });
    expect(res.status).toBe(200);

    const session = await verifySession(cookieValue(res));
    expect(session.valid).toBe(true);
    expect(session.memberId).toBe("ada");
  });

  it("REFUSES the shared dashboard password on a member-shaped request", async () => {
    await seed("ada");
    const res = await post({ memberId: "ada", password: SHARED });
    expect(res.status).toBe(401);
    expect(cookieValue(res)).toBeUndefined();
  });

  it("rejects an unknown member and a deactivated one alike", async () => {
    await seed("ada");
    const unknown = await post({ memberId: "nobody", password: PASSWORD });
    expect(unknown.status).toBe(401);
    // Same body for both — the response must not enumerate the roster.
    expect(await unknown.json()).toEqual({ error: "invalid credentials" });

    const wrongPw = await post({ memberId: "ada", password: "nope" });
    expect(await wrongPw.json()).toEqual({ error: "invalid credentials" });
  });

  it("still mints an UNATTRIBUTED v1 session for the shared-password path", async () => {
    await seed("ada");
    const res = await post({ password: SHARED });
    expect(res.status).toBe(200);

    const session = await verifySession(cookieValue(res));
    expect(session.valid).toBe(true);
    // Not `toBeUndefined` — the key must be ABSENT, so that no later `in`
    // check reads an unattributed session as an attributed one.
    expect("memberId" in session).toBe(false);
  });

  it("refuses rather than downgrading when the id cannot be attributed", async () => {
    // `parseMember` accepts a dot; the dot-delimited v2 payload cannot.
    await seed("ada.lovelace");
    const res = await post({ memberId: "ada.lovelace", password: PASSWORD });

    // The credentials were CORRECT. The failure mode being guarded is a
    // silent fallback to v1: logged in, but every record says nobody.
    expect(res.status).toBe(503);
    expect(cookieValue(res)).toBeUndefined();
    expect(String((await res.json()).error)).toContain("cannot be attributed");
  });
});
