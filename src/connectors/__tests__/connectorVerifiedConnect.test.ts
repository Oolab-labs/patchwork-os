/**
 * A connection is reported only after an authenticated call succeeds.
 *
 * The OAuth callback used to store the exchanged token and report success
 * straight away; the authenticated call that followed was "best-effort" and
 * its failure was swallowed. Status was then derived from the token file
 * existing. A token the provider would reject therefore showed as connected.
 *
 * Now the callback verifies the new token with one authenticated call before
 * reporting success, removes the stored token when that call fails, and
 * records `verified_at` so status can tell a verified connection from a token
 * stored before verification existed (connected, unverified).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const tmpDir = join(os.tmpdir(), `patchwork-verified-connect-${process.pid}`);
const patchworkHome = join(tmpDir, ".patchwork");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("PATCHWORK_HOME", patchworkHome);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  vi.stubEnv("PATCHWORK_GITHUB_CLIENT_ID", "gh-client");
  vi.stubEnv("PATCHWORK_GITHUB_CLIENT_SECRET", "gh-secret");
  mkdirSync(join(patchworkHome, "tokens"), { recursive: true });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ── GitHub ───────────────────────────────────────────────────────────────────

async function githubFlow(userResponse: () => Promise<Response>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchMock = vi.fn<FetchFn>(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    calls.push({ url: String(url), auth });
    if (String(url).includes("/login/oauth/access_token")) {
      return json({ access_token: "gho_newtoken", scope: "repo" });
    }
    if (String(url) === "https://api.github.com/user") return userResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const oauth = await import("../mcpOAuth.js");
  const gh = await import("../github.js");
  const { state } = await oauth.startAuthorize(oauth.vendorConfig("github"));
  const result = await gh.handleGithubCallback("code-1", state, null);
  return { result, calls, oauth, gh };
}

describe("GitHub callback verifies the token before reporting success", () => {
  it("success: /user with the new token, then connected and verified", async () => {
    const { result, calls, oauth, gh } = await githubFlow(async () =>
      json({ login: "octo-user" }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain("GitHub connected as octo-user");
    const userCall = calls.find((c) => c.url === "https://api.github.com/user");
    expect(userCall?.auth).toBe("Bearer gho_newtoken");
    const file = oauth.loadTokenFile("github");
    expect(file?.verified_at).toEqual(expect.any(String));
    expect(gh.getStatus()).toEqual({
      connected: true,
      verified: true,
      user: "octo-user",
    });
    expect(oauth.getConnectorStatus("github")).toMatchObject({
      connected: true,
      verified: true,
    });
  });

  it("/user 401: error page, token removed, not connected", async () => {
    const { result, oauth, gh } = await githubFlow(async () =>
      json({ message: "Bad credentials" }, 401),
    );
    expect(result.status).toBe(400);
    expect(result.body).toContain("GitHub sign-in did not complete:");
    expect(result.body).toContain("401");
    expect(result.body).not.toContain("GitHub connected");
    expect(oauth.loadTokenFile("github")).toBeNull();
    expect(gh.getStatus().connected).toBe(false);
  });

  it("network error on /user: error page, token removed", async () => {
    const { result, oauth } = await githubFlow(async () => {
      throw new TypeError("fetch failed");
    });
    expect(result.status).toBe(400);
    expect(result.body).toContain("GitHub sign-in did not complete:");
    expect(result.body).toContain("fetch failed");
    expect(oauth.loadTokenFile("github")).toBeNull();
  });

  it("the error page never echoes the token", async () => {
    const { result } = await githubFlow(async () =>
      json({ message: "gho_newtoken is bad" }, 401),
    );
    expect(result.body).not.toContain("gho_newtoken");
  });

  it("a token stored before verification existed: connected, unverified", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const oauth = await import("../mcpOAuth.js");
    const { storeSecretJsonSync } = await import("../tokenStorage.js");
    storeSecretJsonSync("github-mcp", {
      vendor: "github",
      client_id: "gh-client",
      access_token: "gho_legacy",
      connected_at: "2026-01-01T00:00:00.000Z",
      profile: { login: "old-user" },
    });
    const gh = await import("../github.js");
    expect(gh.getStatus()).toEqual({
      connected: true,
      verified: false,
      user: "old-user",
    });
    expect(oauth.getConnectorStatus("github")).toMatchObject({
      connected: true,
      verified: false,
    });
  });
});

// ── Linear (same shared helper, MCP-authenticated check) ─────────────────────

async function linearFlow(mcpStatus: number) {
  const fetchMock = vi.fn<FetchFn>(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/register")) return json({ client_id: "lin-client" });
    if (u.endsWith("/token")) return json({ access_token: "lin_newtoken" });
    if (new URL(u).hostname === "mcp.linear.app") {
      if (mcpStatus !== 200) return new Response("denied", { status: 401 });
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
      };
      if (body.id === undefined) return new Response("", { status: 202 });
      if (body.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      }
      if (body.method === "tools/call") {
        return json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ organization: { urlKey: "team-a" } }),
              },
            ],
          },
        });
      }
      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const oauth = await import("../mcpOAuth.js");
  const linear = await import("../linear.js");
  const { state } = await oauth.startAuthorize(oauth.vendorConfig("linear"));
  const result = await linear.handleLinearCallback("code-2", state, null);
  return { result, oauth, linear };
}

describe("Linear callback uses the same verification", () => {
  it("success: connected and verified", async () => {
    const { result, oauth } = await linearFlow(200);
    expect(result.status).toBe(200);
    expect(result.body).toContain("Linear connected");
    expect(oauth.loadTokenFile("linear")?.verified_at).toEqual(
      expect.any(String),
    );
    expect(oauth.getConnectorStatus("linear").verified).toBe(true);
  });

  it("MCP 401: error page, token removed", async () => {
    const { result, oauth, linear } = await linearFlow(401);
    expect(result.status).toBe(400);
    expect(result.body).toContain("Linear sign-in did not complete:");
    expect(oauth.loadTokenFile("linear")).toBeNull();
    expect(linear.getStatus().status).toBe("disconnected");
  });
});
