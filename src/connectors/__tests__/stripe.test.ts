import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("stripe token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-stripe-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.STRIPE_SECRET_KEY;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadTokens returns STRIPE_SECRET_KEY env var without reading storage", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    const { loadTokens } = await import("../stripe.js");
    const tokens = loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.secretKey).toBe("sk_test_abc123");
  });

  it("loadTokens returns null when no env and no stored token", async () => {
    const { loadTokens } = await import("../stripe.js");
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", async () => {
    const { loadTokens, saveTokens } = await import("../stripe.js");
    const tokens = {
      secretKey: "sk_test_roundtrip",
      accountId: "acct_123",
      accountName: "Test Co",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    saveTokens(tokens);
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      secretKey: "sk_test_roundtrip",
      accountId: "acct_123",
    });
  });

  it("clearTokens does not throw even when no file exists", async () => {
    const { clearTokens } = await import("../stripe.js");
    expect(() => clearTokens()).not.toThrow();
  });
});

describe("StripeConnector.healthCheck", () => {
  it("returns ok:true when API responds 200", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ object: "balance" }),
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { StripeConnector } = await import("../stripe.js");
    const conn = new StripeConnector();
    const fakeTokens = {
      secretKey: "sk_test_abc",
      connected_at: new Date().toISOString(),
    };
    (conn as unknown as { tokens: object }).tokens = fakeTokens;
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "sk_test_abc", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when API responds 401", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { StripeConnector } = await import("../stripe.js");
    const conn = new StripeConnector();
    (conn as unknown as { tokens: object }).tokens = {
      secretKey: "sk_test_bad",
      connected_at: new Date().toISOString(),
    };
    vi.spyOn(
      conn as unknown as {
        authenticate: () => Promise<{ token: string; scopes: string[] }>;
      },
      "authenticate",
    ).mockResolvedValue({ token: "sk_test_bad", scopes: [] });

    const result = await conn.healthCheck();
    expect(result.ok).toBe(false);
  });
});

describe("handleStripeConnect", () => {
  it("returns 400 when secretKey missing", async () => {
    vi.resetModules();
    const { handleStripeConnect } = await import("../stripe.js");
    const result = await handleStripeConnect(JSON.stringify({}));
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 400 on invalid JSON", async () => {
    vi.resetModules();
    const { handleStripeConnect } = await import("../stripe.js");
    const result = await handleStripeConnect("not-json");
    expect(result.status).toBe(400);
  });

  it("returns 401 when Stripe rejects credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleStripeConnect } = await import("../stripe.js");
    const result = await handleStripeConnect(
      JSON.stringify({ secretKey: "sk_test_bad" }),
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 and stores accountId + accountName on success", async () => {
    const tmpDir2 = join(os.tmpdir(), `patchwork-stripe-connect-${Date.now()}`);
    const pHome = join(tmpDir2, ".patchwork");
    mkdirSync(join(pHome, "tokens"), { recursive: true });
    process.env.PATCHWORK_HOME = pHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "acct_test123",
        display_name: "Test Business",
      }),
    }) as unknown as typeof fetch;

    vi.resetModules();
    const { handleStripeConnect, loadTokens } = await import("../stripe.js");
    const result = await handleStripeConnect(
      JSON.stringify({ secretKey: "sk_test_goodkey" }),
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.accountId).toBe("acct_test123");
    expect(body.accountName).toBe("Test Business");

    const stored = loadTokens();
    expect(stored?.secretKey).toBe("sk_test_goodkey");
    expect(stored?.accountId).toBe("acct_test123");

    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("handleStripeTest", () => {
  it("returns 400 when not connected", async () => {
    vi.resetModules();
    const { handleStripeTest } = await import("../stripe.js");
    const result = await handleStripeTest();
    expect(result.status).toBe(400);
  });
});

describe("handleStripeDisconnect", () => {
  it("returns 200 always", async () => {
    vi.resetModules();
    const { handleStripeDisconnect } = await import("../stripe.js");
    const result = handleStripeDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
