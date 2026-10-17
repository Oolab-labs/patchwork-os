/**
 * "Connected" must not be read as "works" (audit 2026-10-15, H9).
 *
 * For most connectors `status: "connected"` means only that a credential is
 * stored. Test outcomes were recorded separately and the dashboard ignored
 * them, and a token connector's CONNECT time was reported as `lastSync`, which
 * the dashboard rendered as "Last sync". Slack saved a bot token without ever
 * making an authenticated call — and saved an EMPTY token when the exchange
 * returned none.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = join(os.tmpdir(), `patchwork-test-conn-verified-${process.pid}`);
const home = join(tmpDir, ".patchwork");

beforeEach(() => {
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  delete process.env.STRIPE_SECRET_KEY;
  mkdirSync(join(home, "tokens"), { recursive: true });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("connectionVerification — the latest Test wins", () => {
  it("never tested ⇒ unverified; passing ⇒ verified; latest failing ⇒ failed", async () => {
    const { connectionVerification } = await import("../connectionChecks.js");
    expect(connectionVerification({})).toBe("unverified");
    expect(
      connectionVerification({
        lastCheck: { at: "2026-10-01T00:00:00.000Z", ok: true },
      }),
    ).toBe("verified");
    expect(
      connectionVerification({
        verifiedAt: "2026-10-01T00:00:00.000Z",
        lastCheck: {
          at: "2026-10-02T00:00:00.000Z",
          ok: false,
          reason: "failed",
        },
      }),
    ).toBe("failed");
    // An authenticated call at connect time (MCP vendors) with no Test since.
    expect(connectionVerification({ verified: true })).toBe("verified");
    expect(
      connectionVerification({ verifiedAt: "2026-10-01T00:00:00.000Z" }),
    ).toBe("verified");
  });
});

describe("GET /connections reports verification, and no connect time as a sync", () => {
  const CONNECTED_AT = "2026-01-01T00:00:00.000Z";
  async function stripeEntry() {
    const { handleConnectionsList } = await import("../gmail.js");
    const r = await handleConnectionsList();
    const body = JSON.parse(r.body) as {
      connectors: Array<Record<string, unknown>>;
    };
    return body.connectors.find((c) => c.id === "stripe");
  }

  it("a stored, never-tested credential is connected but UNVERIFIED", async () => {
    const { storeSecretJsonSync } = await import("../tokenStorage.js");
    storeSecretJsonSync("stripe", {
      secretKey: "sk_test_placeholder",
      connected_at: CONNECTED_AT,
    });
    const s = await stripeEntry();
    expect(s?.status).toBe("connected");
    expect(s?.verification).toBe("unverified");
    expect(s?.connectedAt).toBe(CONNECTED_AT);
    // The connect time is not a sync, so it is not reported as one.
    expect(s?.lastSync).toBeUndefined();
  });

  it("follows recorded Tests: passing ⇒ verified, a later failure ⇒ failed", async () => {
    const { storeSecretJsonSync } = await import("../tokenStorage.js");
    const { recordConnectionCheck } = await import("../connectionChecks.js");
    storeSecretJsonSync("stripe", {
      secretKey: "sk_test_placeholder",
      connected_at: CONNECTED_AT,
    });
    recordConnectionCheck(
      "stripe",
      true,
      undefined,
      new Date("2026-10-01T00:00:00Z"),
    );
    expect((await stripeEntry())?.verification).toBe("verified");
    recordConnectionCheck(
      "stripe",
      false,
      "failed",
      new Date("2026-10-02T00:00:00Z"),
    );
    expect((await stripeEntry())?.verification).toBe("failed");
  });
});

describe("Slack saves a token only after an authenticated call", () => {
  async function authorizeState(): Promise<string> {
    vi.stubEnv("PATCHWORK_SLACK_CLIENT_ID", "client-id-placeholder");
    vi.stubEnv("PATCHWORK_SLACK_CLIENT_SECRET", "client-secret-placeholder");
    const { handleSlackAuthorize } = await import("../slack.js");
    const r = handleSlackAuthorize();
    return new URL(r.redirect as string).searchParams.get("state") as string;
  }
  function stubSlack(
    exchange: Record<string, unknown>,
    authTest: Record<string, unknown>,
  ) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        calls.push(new URL(u).pathname);
        const body = u.includes("oauth.v2.access") ? exchange : authTest;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return calls;
  }
  const TEAM = { team: { id: "T0", name: "workspace-placeholder" } };

  it("refuses an exchange that returned no access token, and saves nothing", async () => {
    const state = await authorizeState();
    stubSlack({ ok: true, ...TEAM }, { ok: true });
    const { handleSlackCallback, loadTokens } = await import("../slack.js");
    const r = await handleSlackCallback("code", state, null);
    expect(r.status).toBe(400);
    expect(loadTokens()).toBeNull();
  });

  it("refuses a token auth.test rejects, and saves nothing", async () => {
    const state = await authorizeState();
    const calls = stubSlack(
      { ok: true, access_token: "xoxb-placeholder", ...TEAM },
      { ok: false, error: "invalid_auth" },
    );
    const { handleSlackCallback, loadTokens } = await import("../slack.js");
    const r = await handleSlackCallback("code", state, null);
    expect(calls).toContain("/api/auth.test");
    expect(r.status).toBe(400);
    expect(loadTokens()).toBeNull();
  });

  it("saves a token that passed auth.test, and records it as verified", async () => {
    const state = await authorizeState();
    stubSlack(
      { ok: true, access_token: "xoxb-placeholder", ...TEAM },
      { ok: true },
    );
    const { handleSlackCallback, loadTokens } = await import("../slack.js");
    const r = await handleSlackCallback("code", state, null);
    expect(r.status).toBe(200);
    expect(loadTokens()?.access_token).toBe("xoxb-placeholder");
    const { readConnectionChecks } = await import("../connectionChecks.js");
    expect(readConnectionChecks().slack?.lastCheck?.ok).toBe(true);
  });
});

describe("the route keeps a check the connect flow just recorded", () => {
  it("afterCredentialChange clears a stale check, but not one proven at connect", async () => {
    const {
      afterCredentialChange,
      recordConnectionCheck,
      readConnectionChecks,
    } = await import("../connectionChecks.js");
    recordConnectionCheck("slack", true);
    afterCredentialChange("/connections/slack/callback", { status: 200 });
    expect(readConnectionChecks().slack).toBeUndefined();

    recordConnectionCheck("slack", true);
    afterCredentialChange("/connections/slack/callback", {
      status: 200,
      verifiedAtConnect: true,
    });
    expect(readConnectionChecks().slack?.lastCheck?.ok).toBe(true);
  });
});
