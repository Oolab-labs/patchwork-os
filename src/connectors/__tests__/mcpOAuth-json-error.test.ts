/**
 * Some token endpoints refuse a request with HTTP 200 and a JSON body
 * `{ "error": ..., "error_description": ... }` (GitHub does this for a code
 * exchange and for a refresh). The JSON branch used to return that body as
 * if it were a token, so every refusal surfaced as "empty access_token" /
 * "no access_token" and the actual reason was lost.
 *
 * The reason must be surfaced, and nothing else from the body may be: no
 * token value and no other field ever reaches the thrown message.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LEAK = "ghu_LEAKEDSECRET0001";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("mcpOAuth JSON error bodies on HTTP 200", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-mcp-oauth-jsonerr-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    process.env.PATCHWORK_GITHUB_CLIENT_ID = "gh-client";
    process.env.PATCHWORK_GITHUB_CLIENT_SECRET = "gh-secret";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.PATCHWORK_GITHUB_CLIENT_ID;
    delete process.env.PATCHWORK_GITHUB_CLIENT_SECRET;
    vi.unstubAllGlobals();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  async function exchangeWith(res: Response): Promise<{
    caught: Error | undefined;
    isConnected: (v: "github") => boolean;
  }> {
    const { vendorConfig, startAuthorize, completeAuthorize, isConnected } =
      await import("../mcpOAuth.js");
    const cfg = vendorConfig("github");
    const { state } = await startAuthorize(cfg);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res));
    let caught: Error | undefined;
    try {
      await completeAuthorize(cfg, "auth-code", state);
    } catch (e) {
      caught = e as Error;
    }
    return { caught, isConnected };
  }

  it("code exchange: 200 + JSON error names the reason, not 'empty access_token'", async () => {
    const { caught, isConnected } = await exchangeWith(
      jsonResponse({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
        error_uri: "https://example.test/docs",
        access_token: LEAK,
      }),
    );
    expect(caught?.message).toBe(
      "github: The code passed is incorrect or expired.",
    );
    expect(caught?.message).not.toContain(LEAK);
    expect(caught?.message).not.toContain("example.test");
    expect(isConnected("github")).toBe(false);
  });

  it("code exchange: 200 + JSON error without a description falls back to the code", async () => {
    const { caught } = await exchangeWith(
      jsonResponse({ error: "incorrect_client_credentials" }),
    );
    expect(caught?.message).toBe("github: incorrect_client_credentials");
  });

  it("code exchange: an oversized description is capped and carries no body field", async () => {
    const { caught } = await exchangeWith(
      jsonResponse({
        error: "redirect_uri_mismatch",
        error_description: `x${"y".repeat(5000)}\n${LEAK}`,
        access_token: LEAK,
      }),
    );
    expect(caught).toBeDefined();
    expect(caught?.message.length).toBeLessThanOrEqual(220);
    expect(caught?.message).not.toContain(LEAK);
    expect(caught?.message).not.toContain("\n");
  });

  it("code exchange: 200 + JSON success is unchanged", async () => {
    const { caught, isConnected } = await exchangeWith(
      jsonResponse({ access_token: "gho_valid", scope: "repo" }),
    );
    expect(caught).toBeUndefined();
    expect(isConnected("github")).toBe(true);
  });

  it("code exchange: 200 + form-encoded error is unchanged", async () => {
    const { caught } = await exchangeWith(
      new Response(
        "error=bad_verification_code&error_description=The+code+passed+is+incorrect+or+expired.",
        {
          status: 200,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
      ),
    );
    expect(caught?.message).toBe(
      "github: The code passed is incorrect or expired.",
    );
  });

  it("refresh: 200 + JSON error names the reason and keeps the stored token", async () => {
    writeFileSync(
      join(tokensDir, "github-mcp.json"),
      JSON.stringify({
        vendor: "github",
        client_id: "gh-client",
        access_token: "stale-access-token",
        refresh_token: "ghr_stored",
        expires_at: Date.now() - 60_000,
        connected_at: "2026-04-23T00:00:00.000Z",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          error: "bad_refresh_token",
          error_description:
            "The refresh token passed is incorrect or expired.",
          access_token: LEAK,
        }),
      ),
    );
    const { getAccessToken, isConnected } = await import("../mcpOAuth.js");
    let caught: Error | undefined;
    try {
      await getAccessToken("github");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain(
      "The refresh token passed is incorrect or expired.",
    );
    expect(caught?.message).not.toContain("no access_token");
    expect(caught?.message).not.toContain(LEAK);
    expect(caught?.message).not.toContain("ghr_stored");
    expect(isConnected("github")).toBe(true);
  });
});
