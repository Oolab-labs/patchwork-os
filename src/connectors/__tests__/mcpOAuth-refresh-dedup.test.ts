/**
 * Regression test: concurrent `getAccessToken("linear")` calls when the stored
 * token is expired must coalesce into a single POST to the token endpoint.
 *
 * Without dedup, two parallel tool calls each fire a refresh; the second
 * burns the rotated refresh_token from the first and invalidates the
 * connector — same failure mode as Google in BaseConnector. Linear, Sentry,
 * and GitHub all rotate refresh tokens.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcpOAuth refresh dedup", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-mcp-oauth-dedup-${Date.now()}`);
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
    vi.unstubAllGlobals();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("coalesces N concurrent getAccessToken() into a single token POST", async () => {
    // Stage an expired Linear token (legacy file form is fine — loadTokenFile
    // migrates it into encrypted storage on first read).
    const legacy = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "stale-access-token",
      refresh_token: "rt_v1",
      // Already expired — refreshIfNeeded should fire.
      expires_at: Date.now() - 60_000,
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(legacy, null, 2),
    );

    let resolveFetch!: (res: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");

    // Fire 5 concurrent getAccessToken calls before the first refresh resolves.
    const calls = Array.from({ length: 5 }, () => getAccessToken("linear"));

    // Yield the microtask queue so all 5 reach the in-flight check.
    await Promise.resolve();
    await Promise.resolve();

    resolveFetch(
      new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "rt_v2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const results = await Promise.all(calls);

    // Single network call → single rotated refresh_token consumption.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((t) => t === "fresh-access-token")).toBe(true);
  });

  it("clears inflight cache after success — next caller refetches", async () => {
    const legacy = {
      vendor: "linear" as const,
      client_id: "linear-client-id",
      access_token: "stale-access-token",
      refresh_token: "rt_v1",
      expires_at: Date.now() - 60_000,
      connected_at: "2026-04-23T00:00:00.000Z",
    };
    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(legacy, null, 2),
    );

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "first-fresh",
            refresh_token: "rt_v2",
            expires_in: 1, // 1s lifetime → already in expiry buffer (5min) → next call refreshes again
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAccessToken } = await import("../mcpOAuth.js");

    await getAccessToken("linear");
    // Second call: inflight slot is cleared, so a new POST happens.
    await getAccessToken("linear");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
