/**
 * Refresh and revoke must present the CURRENT configured client secret, not
 * the copy captured in the token file at connect time. After an operator
 * rotates a pre-registered client's secret, the stored copy is the old one
 * and the provider rejects it. Dynamically registered clients have no
 * configured secret, so the stored copy remains the only source for them.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcpOAuth client secret on refresh / revoke", () => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-mcp-oauth-secret-${process.pid}-${Date.now()}`,
  );
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "HOME",
    "USERPROFILE",
    "PATCHWORK_HOME",
    "PATCHWORK_TOKEN_STORAGE_BACKEND",
    "PATCHWORK_GITHUB_CLIENT_ID",
    "PATCHWORK_GITHUB_CLIENT_SECRET",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.unstubAllGlobals();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function stageToken(vendor: "github" | "linear", clientSecret: string): void {
    writeFileSync(
      join(tokensDir, `${vendor}-mcp.json`),
      JSON.stringify({
        vendor,
        client_id: `${vendor}-client-id`,
        client_secret: clientSecret,
        access_token: "stale-access-token",
        refresh_token: "rt_v1",
        expires_at: Date.now() - 60_000,
        connected_at: "2026-04-23T00:00:00.000Z",
      }),
    );
  }

  function okFetch() {
    return vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fresh-access-token",
            refresh_token: "rt_v2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  }

  function sentSecret(fetchMock: ReturnType<typeof vi.fn>): string | null {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return new URLSearchParams(init.body as string).get("client_secret");
  }

  it("refresh uses the rotated configured secret, not the stored copy", async () => {
    process.env.PATCHWORK_GITHUB_CLIENT_ID = "github-client-id";
    process.env.PATCHWORK_GITHUB_CLIENT_SECRET = "rotated-secret";
    stageToken("github", "connect-time-secret");
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");
    expect(await getAccessToken("github")).toBe("fresh-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentSecret(fetchMock)).toBe("rotated-secret");
  });

  it("refresh falls back to the stored copy when nothing is configured", async () => {
    delete process.env.PATCHWORK_GITHUB_CLIENT_SECRET;
    stageToken("github", "connect-time-secret");
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");
    await getAccessToken("github");
    expect(sentSecret(fetchMock)).toBe("connect-time-secret");
  });

  it("dynamic registration: refresh still sends the registered secret", async () => {
    // A configured secret for ANOTHER vendor must not leak into this one.
    process.env.PATCHWORK_GITHUB_CLIENT_SECRET = "rotated-secret";
    stageToken("linear", "dyn-reg-secret");
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");
    await getAccessToken("linear");
    expect(sentSecret(fetchMock)).toBe("dyn-reg-secret");
  });

  it("dynamic registration: revoke still sends the registered secret", async () => {
    stageToken("linear", "dyn-reg-secret");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { revoke } = await import("../mcpOAuth.js");
    await revoke("linear");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentSecret(fetchMock)).toBe("dyn-reg-secret");
  });

  it("clientSecretFor (the revoke and refresh source) prefers configuration", async () => {
    const { clientSecretFor, vendorConfig } = await import("../mcpOAuth.js");
    const file = {
      vendor: "github" as const,
      client_id: "github-client-id",
      client_secret: "connect-time-secret",
      access_token: "a",
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    process.env.PATCHWORK_GITHUB_CLIENT_SECRET = "rotated-secret";
    expect(clientSecretFor(vendorConfig("github"), file)).toBe(
      "rotated-secret",
    );
    delete process.env.PATCHWORK_GITHUB_CLIENT_SECRET;
    expect(clientSecretFor(vendorConfig("github"), file)).toBe(
      "connect-time-secret",
    );
  });
});
