/**
 * Regression tests for mcpOAuth refresh + revoke hardening.
 *
 * Pre-fix mcpOAuth.doRefresh (#37/#104 in BaseConnector) was missing four
 * guards that the canonical BaseConnector.refreshToken enforces, and
 * mcpOAuth.revoke posted the access_token to /token even when a refresh
 * token existed. Audit 2026-05-17.
 *
 *   - HTTPS protocol check on tokenEndpoint
 *   - access_token type/length validation on success body
 *   - expires_in bounds check (positive finite ≤ 1 year)
 *   - 401 / 400+invalid_grant → deleteTokenFile (permanent failure)
 *   - revoke prefers refresh_token + sets token_type_hint
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcpOAuth hardening", () => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-mcp-oauth-hardening-${Date.now()}`,
  );
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  function stageExpiredLinearToken(refreshToken: string = "rt_v1"): void {
    const legacy = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "stale-access-token",
      refresh_token: refreshToken,
      expires_at: Date.now() - 60_000,
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(legacy, null, 2),
    );
  }

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    vi.unstubAllGlobals();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // HTTPS-only check on tokenEndpoint is exercised at code-review level:
  // linear/sentry/github vendor configs all hardcode `https://` and
  // `vendorConfig` is not user-overridable at runtime. The guard catches
  // the future case where discovery / env override could supply http://.

  it("treats 401 as permanent → deletes token file", async () => {
    stageExpiredLinearToken();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken, isConnected } = await import("../mcpOAuth.js");

    await expect(getAccessToken("linear")).rejects.toThrow(/refresh failed/);

    // Token file should be gone — next call surfaces "not connected".
    expect(isConnected("linear")).toBe(false);
  });

  it("treats 400 invalid_grant as permanent → deletes token file", async () => {
    stageExpiredLinearToken();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken, isConnected } = await import("../mcpOAuth.js");

    await expect(getAccessToken("linear")).rejects.toThrow(/refresh failed/);
    expect(isConnected("linear")).toBe(false);
  });

  it("treats 500 / other failures as transient → keeps token file", async () => {
    stageExpiredLinearToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken, isConnected } = await import("../mcpOAuth.js");

    await expect(getAccessToken("linear")).rejects.toThrow(/refresh failed/);
    // Token file MUST survive transient failures — flaky wifi shouldn't
    // force a full re-OAuth.
    expect(isConnected("linear")).toBe(true);
  });

  it("rejects empty access_token in success body (no `Bearer undefined` persist)", async () => {
    stageExpiredLinearToken();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");
    await expect(getAccessToken("linear")).rejects.toThrow(/no access_token/);
  });

  it("rejects absurd expires_in (> 1 year)", async () => {
    stageExpiredLinearToken();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "fresh",
          expires_in: 60 * 60 * 24 * 400, // 400 days
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");
    await expect(getAccessToken("linear")).rejects.toThrow(
      /invalid expires_in/,
    );
  });

  it("rejects negative / zero expires_in", async () => {
    stageExpiredLinearToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "fresh", expires_in: -10 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");
    await expect(getAccessToken("linear")).rejects.toThrow(
      /invalid expires_in/,
    );
  });

  it("revoke prefers refresh_token + sets token_type_hint", async () => {
    // Stage a fresh (non-expired) Linear token with both access + refresh.
    const file = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "live-access-token",
      refresh_token: "live-refresh-token",
      expires_at: Date.now() + 3_600_000,
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(file, null, 2),
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { revoke } = await import("../mcpOAuth.js");
    await revoke("linear");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("token")).toBe("live-refresh-token");
    expect(body.get("token_type_hint")).toBe("refresh_token");
  });

  it("revoke falls back to access_token when no refresh exists", async () => {
    const file = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "only-access-token",
      // no refresh_token
      expires_at: Date.now() + 3_600_000,
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(file, null, 2),
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { revoke } = await import("../mcpOAuth.js");
    await revoke("linear");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("token")).toBe("only-access-token");
    expect(body.get("token_type_hint")).toBe(null);
  });
});
