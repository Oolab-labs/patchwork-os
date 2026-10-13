/**
 * A passing connection Test proves the stored token works, so it stamps
 * `verified_at` the same way the OAuth callback does. A failing Test reports
 * the failure but neither stamps nor removes the token: a transient upstream
 * failure must not disconnect anyone.
 *
 * GET /connections reports `verified` for every connector whose tokens go
 * through the verified-authorize helper (GitHub, Linear, Sentry), with one
 * rule: true iff the stored token carries `verified_at`.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Vendor = "github" | "linear" | "sentry";

const tmpDir = join(
  os.tmpdir(),
  `patchwork-test-marks-verified-${process.pid}`,
);
const patchworkHome = join(tmpDir, ".patchwork");

const MCP_HOST: Record<Vendor, string> = {
  github: "api.githubcopilot.com",
  linear: "mcp.linear.app",
  sentry: "mcp.sentry.dev",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("PATCHWORK_HOME", patchworkHome);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  vi.stubEnv("LINEAR_API_KEY", "");
  delete process.env.LINEAR_API_KEY;
  mkdirSync(join(patchworkHome, "tokens"), { recursive: true });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** MCP mock: answers only a request bearing `acceptToken`; else `status`. */
function stubMcp(
  vendor: Vendor,
  acceptToken: string,
  failStatus?: number,
): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  const fetchMock = vi.fn<FetchFn>(async (url, init) => {
    const u = String(url);
    if (new URL(u).hostname !== MCP_HOST[vendor]) {
      throw new Error(`unexpected fetch ${u}`);
    }
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    seen.push(auth);
    if (failStatus !== undefined) {
      return new Response("upstream says no", { status: failStatus });
    }
    if (auth !== `Bearer ${acceptToken}`) {
      return new Response("denied", { status: 401 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
    };
    if (body.id === undefined) return new Response("", { status: 202 });
    if (body.method === "tools/list") {
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    }
    return json({ jsonrpc: "2.0", id: body.id, result: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return seen;
}

async function seedToken(
  vendor: Vendor,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { storeSecretJsonSync } = await import("../tokenStorage.js");
  storeSecretJsonSync(`${vendor}-mcp`, {
    vendor,
    client_id: `${vendor}-client`,
    access_token: `${vendor}_stored`,
    connected_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

async function runTest(vendor: Vendor) {
  if (vendor === "github") {
    return (await import("../github.js")).handleGithubTest();
  }
  if (vendor === "linear") {
    return (await import("../linear.js")).handleLinearTest();
  }
  return (await import("../sentry.js")).handleSentryTest();
}

async function listed(id: Vendor): Promise<Record<string, unknown>> {
  const { handleConnectionsList } = await import("../gmail.js");
  const res = await handleConnectionsList();
  const { connectors } = JSON.parse(res.body) as {
    connectors: Array<Record<string, unknown>>;
  };
  const entry = connectors.find((c) => c.id === id);
  if (!entry) throw new Error(`${id} missing from GET /connections`);
  return entry;
}

describe.each<Vendor>([
  "github",
  "linear",
  "sentry",
])("%s connection Test", (vendor) => {
  it("success stamps verified_at; GET /connections then reports verified:true", async () => {
    await seedToken(vendor);
    const seen = stubMcp(vendor, `${vendor}_stored`);
    expect((await listed(vendor)).verified).toBe(false);

    const result = await runTest(vendor);
    expect(JSON.parse(result.body).ok).toBe(true);
    expect(seen).toContain(`Bearer ${vendor}_stored`);

    const oauth = await import("../mcpOAuth.js");
    const file = oauth.loadTokenFile(vendor);
    expect(file?.verified_at).toEqual(expect.any(String));
    expect(file?.access_token).toBe(`${vendor}_stored`);
    expect(await listed(vendor)).toMatchObject({
      status: "connected",
      verified: true,
    });
  });

  it("failure reports the failure, leaves the token, does not stamp", async () => {
    await seedToken(vendor);
    stubMcp(vendor, `${vendor}_stored`, 401);

    const result = await runTest(vendor);
    expect(JSON.parse(result.body).ok).toBe(false);

    const oauth = await import("../mcpOAuth.js");
    const file = oauth.loadTokenFile(vendor);
    expect(file?.access_token).toBe(`${vendor}_stored`);
    expect(file?.verified_at).toBeUndefined();
    expect(await listed(vendor)).toMatchObject({
      status: "connected",
      verified: false,
    });
  });

  it("failure on an already-verified token leaves verified unchanged", async () => {
    const stamp = "2026-02-02T00:00:00.000Z";
    await seedToken(vendor, { verified_at: stamp });
    stubMcp(vendor, `${vendor}_stored`, 503);

    const result = await runTest(vendor);
    expect(JSON.parse(result.body).ok).toBe(false);

    const oauth = await import("../mcpOAuth.js");
    expect(oauth.loadTokenFile(vendor)?.verified_at).toBe(stamp);
    expect((await listed(vendor)).verified).toBe(true);
  });

  it("not connected: GET /connections carries no verified claim", async () => {
    stubMcp(vendor, "unused");
    const entry = await listed(vendor);
    expect(entry.status).toBe("disconnected");
    expect(entry).not.toHaveProperty("verified");
  });
});

describe("Linear with an environment key", () => {
  it("a passing Test proves the env key, so the stored token is NOT stamped", async () => {
    await seedToken("linear");
    vi.stubEnv("LINEAR_API_KEY", "lin_env_key");
    const seen = stubMcp("linear", "lin_env_key");

    const result = await runTest("linear");
    expect(JSON.parse(result.body).ok).toBe(true);
    expect(seen).toContain("Bearer lin_env_key");

    const oauth = await import("../mcpOAuth.js");
    expect(oauth.loadTokenFile("linear")?.verified_at).toBeUndefined();
    // The env key is not a verified-authorize token: no verified claim.
    expect(await listed("linear")).not.toHaveProperty("verified");
  });
});
