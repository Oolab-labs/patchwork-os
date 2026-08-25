/** @vitest-environment node */
/**
 * `DASHBOARD_ALLOW_UNAUTHENTICATED=1` bypasses the dashboard auth gate. In
 * production that is a serious state, and the middleware already has a loud
 * `DANGEROUS:` warning for it — but the warning lives in the SECOND branch:
 *
 *   if (!expected || !secret) {                       // no password configured
 *     if (production && !ALLOW) return 503;
 *     return next();                                  // <- open, and SILENT
 *   }
 *   if (ALLOW) {
 *     if (production && expected) { console.error("DANGEROUS…"); return 503; }
 *     ...
 *   }
 *
 * So whether an operator is warned depends on whether a password HAPPENS to be
 * configured — and the strictly less secure configuration, no password at all,
 * is the silent one. The severity signal is inverted exactly where it matters.
 *
 * These tests assert the warning on the bypass path and, in the other
 * direction, that development stays quiet — a warning that fires on every local
 * `npm run dev` is one people learn to scroll past, which is how a real one gets
 * missed.
 *
 * `ALLOW_UNAUTHENTICATED` is captured at module scope, so each case must set the
 * environment and then re-import.
 */

import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG = {
  allow: process.env.DASHBOARD_ALLOW_UNAUTHENTICATED,
  pw: process.env.DASHBOARD_PASSWORD,
  secret: process.env.DASHBOARD_SESSION_SECRET,
  nodeEnv: process.env.NODE_ENV,
};

function setNodeEnv(v: string): void {
  // NODE_ENV is readonly in the Next type augmentation; the runtime value is
  // what the middleware reads. `vi.stubEnv` handles the descriptor vitest's
  // env proxy insists on (configurable AND enumerable).
  vi.stubEnv("NODE_ENV", v as "production" | "development" | "test");
}

async function runMiddleware(env: {
  production: boolean;
  password?: string;
  secret?: string;
  allow: boolean;
}) {
  setNodeEnv(env.production ? "production" : "development");
  if (env.password === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = env.password;
  if (env.secret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
  else process.env.DASHBOARD_SESSION_SECRET = env.secret;
  if (env.allow) process.env.DASHBOARD_ALLOW_UNAUTHENTICATED = "1";
  else delete process.env.DASHBOARD_ALLOW_UNAUTHENTICATED;

  vi.resetModules();
  const { middleware } = await import("./middleware");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/runs") as NextRequest;
  return middleware(req);
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [k, v] of [
    ["DASHBOARD_ALLOW_UNAUTHENTICATED", ORIG.allow],
    ["DASHBOARD_PASSWORD", ORIG.pw],
    ["DASHBOARD_SESSION_SECRET", ORIG.secret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Did anything logged mention the bypass loudly? */
function warned(): boolean {
  return (errSpy.mock.calls.flat() as unknown[]).some(
    (a) => typeof a === "string" && a.includes("DASHBOARD_ALLOW_UNAUTHENTICATED"),
  );
}

describe("production auth bypass must announce itself", () => {
  it("warns when the bypass opens production with NO password configured", async () => {
    // The silent branch. Auth is off, in production, and nothing says so.
    const res = await runMiddleware({ production: true, allow: true });
    expect(res.status).toBe(200); // still open — behaviour deliberately unchanged
    expect(warned()).toBe(true);
  });

  it("warns when the bypass is set in production WITH a password (control)", async () => {
    // Pre-existing behaviour: this branch already warned, and refuses.
    const res = await runMiddleware({
      production: true,
      password: "pw",
      secret: "s".repeat(32),
      allow: true,
    });
    expect(res.status).toBe(503);
    expect(warned()).toBe(true);
  });
});

describe("the warning stays quiet where the bypass is legitimate", () => {
  it("does NOT warn in development with no password", async () => {
    const res = await runMiddleware({ production: false, allow: true });
    expect(res.status).toBe(200);
    expect(warned()).toBe(false);
  });

  it("does NOT warn when the bypass is not set at all", async () => {
    // Production with no password and no bypass still refuses, and the refusal
    // message is the signal — no extra warning needed.
    const res = await runMiddleware({ production: true, allow: false });
    expect(res.status).toBe(503);
    expect(warned()).toBe(false);
  });
});
