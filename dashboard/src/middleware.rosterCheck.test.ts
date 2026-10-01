/** @vitest-environment node */
/**
 * A v2 (attributed) session cookie names a member. Until 2026-10-01 the
 * middleware verified only the signature and the expiry, so deactivating a
 * member — or deleting them from members.json — ended nothing for up to 30
 * days: the cookie kept working, and because the bridge resolves the approver
 * AFTER `queue.approve()` lands, a deactivated member could still approve a
 * gated action and the durable log would name nobody. The only revocation was
 * rotating DASHBOARD_SESSION_SECRET, which logs out everyone.
 *
 * Now a v2 cookie is also checked against the roster on every request, with
 * the SAME rule the bridge uses for attribution (`resolveSessionMember`):
 * implicit roster ⇒ not honoured, missing ⇒ no, deactivated ⇒ no, unreadable
 * roster ⇒ no. v1 cookies are untouched — the shared password names nobody,
 * so there is nobody to check.
 *
 * Reading a file in middleware needs the Node runtime (`config.runtime`),
 * which this file pins.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s".repeat(32);
let home: string;

function writeRoster(members: unknown[] | string): void {
  const body = typeof members === "string" ? members : JSON.stringify(members);
  fs.writeFileSync(path.join(home, "members.json"), body);
}

async function load() {
  vi.resetModules();
  const mw = await import("./middleware");
  const session = await import("@/lib/session");
  const cache = await import("@/lib/sessionRoster");
  cache._resetSessionRosterCacheForTests();
  return { ...mw, ...session };
}

async function request(cookie: string | undefined, accept = "application/json") {
  const { middleware, SESSION_COOKIE_NAME } = await load();
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = { accept };
  if (cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  const req = new NextRequest("http://localhost/runs", { headers }) as NextRequest;
  return middleware(req);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pw-mw-roster-"));
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DASHBOARD_PASSWORD", "pw");
  vi.stubEnv("DASHBOARD_SESSION_SECRET", SECRET);
  vi.stubEnv("DASHBOARD_ALLOW_UNAUTHENTICATED", "");
  delete process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const ADA = { id: "ada", displayName: "Ada", roles: ["operator"] };

describe("middleware — v2 session must still name an ACTIVE roster member", () => {
  it("runs on the Node runtime (it reads members.json)", async () => {
    const { config } = await load();
    expect((config as { runtime?: string }).runtime).toBe("nodejs");
  });

  it("active member → request proceeds", async () => {
    writeRoster([ADA]);
    const { signSession } = await load();
    const res = await request(await signSession({ memberId: "ada" }));
    // NextResponse.next() carries the x-middleware-next marker; a 401 would not.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("deactivated member → 401, and the cookie is cleared", async () => {
    writeRoster([{ ...ADA, active: false }]);
    const { signSession } = await load();
    const res = await request(await signSession({ memberId: "ada" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/patchwork_session=;.*Max-Age=0/);
  });

  it("member removed from the roster → 401", async () => {
    writeRoster([{ id: "bob", displayName: "Bob", roles: ["operator"] }]);
    const { signSession } = await load();
    const res = await request(await signSession({ memberId: "ada" }));
    expect(res.status).toBe(401);
  });

  it("no members.json (implicit roster) → a v2 cookie is NOT honoured", async () => {
    // Same rule as attribution: a cookie naming a member cannot be honoured
    // against a roster that was synthesised rather than read.
    const { signSession } = await load();
    const res = await request(await signSession({ memberId: "ada" }));
    expect(res.status).toBe(401);
  });

  it("unreadable members.json → v2 rejected (fail closed), v1 still works", async () => {
    writeRoster("{not json");
    const { signSession } = await load();
    expect((await request(await signSession({ memberId: "ada" }))).status).toBe(401);
    expect((await request(await signSession())).status).toBe(200);
  });

  it("v1 (shared-password) cookie is unaffected by the roster", async () => {
    writeRoster([{ ...ADA, active: false }]);
    const { signSession } = await load();
    const res = await request(await signSession());
    expect(res.status).toBe(200);
  });

  it("deactivation takes effect WITHOUT a restart, once the cache window passes", async () => {
    writeRoster([ADA]);
    const { signSession } = await load();
    const cookie = await signSession({ memberId: "ada" });
    expect((await request(cookie)).status).toBe(200);
    writeRoster([{ ...ADA, active: false }]);
    const cache = await import("@/lib/sessionRoster");
    cache._resetSessionRosterCacheForTests();
    expect((await request(cookie)).status).toBe(401);
  });

  it("HTML navigation by a deactivated member redirects to /login", async () => {
    writeRoster([{ ...ADA, active: false }]);
    const { signSession } = await load();
    const res = await request(await signSession({ memberId: "ada" }), "text/html");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/login");
  });
});
