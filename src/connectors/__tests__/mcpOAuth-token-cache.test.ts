/**
 * Regression test (audit 2026-06-10 connectors-core-5): getAccessToken() must
 * not hit the secret store (spawnSync keychain on macOS/Windows, file read on
 * the file backend) on every call. mcpClient.post() calls getAccessToken() on
 * every MCP POST; the previous implementation re-loaded the token file each
 * time, spawning a blocking keychain process per request. A short-TTL in-memory
 * cache must serve a still-valid access token without re-reading the store.
 *
 * Rather than spy on fs internals (not configurable under ESM), this test
 * proves cache behavior observably: it removes the underlying store between
 * calls. If the cache is working the second call still resolves the cached
 * token; if it isn't (every call re-reads the store), the call would fail.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcpOAuth access-token cache (connectors-core-5)", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-mcp-oauth-cache-${Date.now()}`);
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
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("serves a still-valid access token from cache after the store is removed", async () => {
    // A token comfortably valid (past the 5-min refresh buffer) so
    // refreshIfNeeded never fires a network call.
    const legacy = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "valid-access-token",
      refresh_token: "rt_v1",
      expires_at: Date.now() + 60 * 60 * 1000, // +1h
      connected_at: "2026-06-10T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(legacy, null, 2),
    );

    const { getAccessToken } = await import("../mcpOAuth.js");

    // First call migrates legacy → .enc and populates the cache.
    expect(await getAccessToken("linear")).toBe("valid-access-token");

    // Wipe the entire token store. A per-call store read would now fail; the
    // cache must still serve the previously-loaded token.
    rmSync(tokensDir, { recursive: true, force: true });

    expect(await getAccessToken("linear")).toBe("valid-access-token");
  });

  it("invalidates the cache on token save so a removed store is no longer served", async () => {
    const legacy = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "v1-access",
      refresh_token: "rt_v1",
      expires_at: Date.now() + 60 * 60 * 1000,
      connected_at: "2026-06-10T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(legacy, null, 2),
    );

    const { getAccessToken, updateTokenProfile } = await import(
      "../mcpOAuth.js"
    );

    expect(await getAccessToken("linear")).toBe("v1-access");

    // saveTokenFile (via updateTokenProfile) must invalidate the cache.
    updateTokenProfile("linear", { workspace: "acme" });

    // Remove the store. With the cache invalidated, getAccessToken must now
    // consult the (missing) store and throw — proving it isn't serving stale
    // cached state past a save.
    rmSync(tokensDir, { recursive: true, force: true });

    await expect(getAccessToken("linear")).rejects.toThrow(/not connected/);
  });
});
