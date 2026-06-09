/**
 * Audit 2026-06-08 HIGH (connectors-core-2): the token-exchange and
 * dynamic-registration error paths embedded the first 300 bytes of the IdP's
 * raw response body into the thrown Error. That Error propagates up through the
 * connector callback handlers into the HTTP response shown to the browser AND
 * into server logs. Some IdPs (e.g. GitHub's form-encoded responses) include
 * an access_token or other sensitive values in their error bodies — so the raw
 * snippet must never appear in the thrown Error. Only the HTTP status is safe
 * to surface.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcpOAuth error redaction", () => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-mcp-oauth-redaction-${Date.now()}`,
  );
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

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
    delete process.env.PATCHWORK_GITHUB_CLIENT_ID;
    delete process.env.PATCHWORK_GITHUB_CLIENT_SECRET;
    vi.unstubAllGlobals();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("token-exchange failure error excludes the raw body / access_token (github form-encoded)", async () => {
    process.env.PATCHWORK_GITHUB_CLIENT_ID = "gh-client";
    process.env.PATCHWORK_GITHUB_CLIENT_SECRET = "gh-secret";
    const { vendorConfig, startAuthorize, completeAuthorize } = await import(
      "../mcpOAuth.js"
    );
    const cfg = vendorConfig("github"); // non-dyn-reg → no fetch in startAuthorize
    const { state } = await startAuthorize(cfg);

    // A GitHub-style form-encoded error body that *includes a token*.
    const leakyBody =
      "error=bad_verification_code&access_token=ghu_LEAKEDSECRET0001&error_description=secretdetail";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(leakyBody, {
          status: 400,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
      ),
    );

    let caught: Error | undefined;
    try {
      await completeAuthorize(cfg, "auth-code", state);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain("ghu_LEAKEDSECRET0001");
    expect(caught?.message).not.toContain("access_token");
    expect(caught?.message).not.toContain("secretdetail");
    // Status is still surfaced for diagnosis.
    expect(caught?.message).toMatch(/token exchange/i);
    expect(caught?.message).toMatch(/400/);
  });

  it("dynamic-registration failure error excludes the raw response body", async () => {
    const { vendorConfig, startAuthorize } = await import("../mcpOAuth.js");
    const cfg = vendorConfig("sentry"); // useDynamicRegistration: true
    const leakyBody = JSON.stringify({
      error: "invalid_client",
      registration_access_token: "REG_SECRET_9999",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(leakyBody, {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    let caught: Error | undefined;
    try {
      await startAuthorize(cfg);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain("REG_SECRET_9999");
    expect(caught?.message).not.toContain("registration_access_token");
    expect(caught?.message).toMatch(/dyn-reg/i);
    expect(caught?.message).toMatch(/401/);
  });
});
