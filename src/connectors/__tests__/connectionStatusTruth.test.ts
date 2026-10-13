/**
 * `GET /connections` says only what was recorded, a connection Test records
 * its outcome for every connector, and a disconnect says what happened to
 * the credential at the provider.
 *
 *   1. No fabricated `lastSync`: a timestamp made at read time is absent.
 *   2. `connectedAt` / `account` come from what the connector stored.
 *   3. `POST /connections/<id>/test` records `verifiedAt` + `lastCheck`
 *      (short reason code, never a response body); dropped on reconnect and
 *      on disconnect.
 *   4. `DELETE /connections/<id>` answers `{ok, removed, revoked}` where
 *      `revoked` is the real outcome of the provider revoke, and the local
 *      credential is removed even when the revoke fails.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const tmpDir = join(os.tmpdir(), `patchwork-conn-truth-${process.pid}`);
const home = join(tmpDir, ".patchwork");

beforeEach(() => {
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("PATCHWORK_TOKEN_DIR", join(home, "tokens"));
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  for (const k of ["NOTION_TOKEN", "LINEAR_API_KEY", "STRIPE_SECRET_KEY"]) {
    vi.stubEnv(k, "");
    delete process.env[k];
  }
  mkdirSync(join(home, "tokens"), { recursive: true });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

async function store(provider: string, value: unknown): Promise<void> {
  const { storeSecretJsonSync } = await import("../tokenStorage.js");
  storeSecretJsonSync(provider, value);
}

async function stored(provider: string): Promise<unknown> {
  const { getSecretJsonSync } = await import("../tokenStorage.js");
  return getSecretJsonSync(provider);
}

async function listed(id: string): Promise<Record<string, unknown>> {
  const { handleConnectionsList } = await import("../gmail.js");
  const res = await handleConnectionsList();
  const { connectors } = JSON.parse(res.body) as {
    connectors: Array<Record<string, unknown>>;
  };
  const entry = connectors.find((c) => c.id === id);
  if (!entry) throw new Error(`${id} missing from GET /connections`);
  return entry;
}

/** Drive a real route through `tryHandleConnectorRoute`. */
async function route(
  method: string,
  path: string,
  pub = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const routes = await import("../../connectorRoutes.js");
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  let status = 0;
  let resolve!: (b: string) => void;
  const done = new Promise<string>((r) => {
    resolve = r;
  });
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(b?: string) {
      resolve(b ?? "");
      return this;
    },
  } as unknown as ServerResponse;
  const handled = pub
    ? routes.tryHandlePublicConnectorRoute(req, res, new URL(`http://x${path}`))
    : routes.tryHandleConnectorRoute(req, res, new URL(`http://x${path}`));
  expect(handled).toBe(true);
  const text = await done;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status, body };
}

const GMAIL_TOKENS = {
  access_token: "gm_access",
  refresh_token: "gm_refresh",
  expiry_date: Date.now() + 3_600_000,
};

describe("GET /connections reports only recorded timestamps", () => {
  it("gmail, github, slack: no lastSync made up at read time", async () => {
    await store("gmail", GMAIL_TOKENS);
    await store("github-mcp", {
      vendor: "github",
      client_id: "c",
      access_token: "gh_stored",
      connected_at: "2026-01-01T00:00:00.000Z",
      profile: { login: "octo-example" },
    });
    await store("slack", {
      access_token: "xoxb-example",
      team_id: "T0",
      team_name: "example-team",
      bot_user_id: "B0",
      connected_at: "2026-03-03T00:00:00.000Z",
    });
    expect(await listed("gmail")).toMatchObject({ status: "connected" });
    expect(await listed("gmail")).not.toHaveProperty("lastSync");
    expect(await listed("github")).not.toHaveProperty("lastSync");
    expect(await listed("slack")).not.toHaveProperty("lastSync");
  });

  it("surfaces stored connectedAt and account label", async () => {
    await store("github-mcp", {
      vendor: "github",
      client_id: "c",
      access_token: "gh_stored",
      connected_at: "2026-01-01T00:00:00.000Z",
      verified_at: "2026-01-01T00:00:01.000Z",
      profile: { login: "octo-example" },
    });
    await store("notion", {
      accessToken: "secret_example",
      workspaceName: "Example Workspace",
      connected_at: "2026-02-02T00:00:00.000Z",
    });
    expect(await listed("github")).toMatchObject({
      connectedAt: "2026-01-01T00:00:00.000Z",
      account: "octo-example",
      verifiedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(await listed("notion")).toMatchObject({
      status: "connected",
      connectedAt: "2026-02-02T00:00:00.000Z",
      account: "Example Workspace",
    });
  });

  it("an environment key's synthesised connected_at is not reported", async () => {
    vi.stubEnv("NOTION_TOKEN", "secret_env");
    const entry = await listed("notion");
    expect(entry.status).toBe("connected");
    expect(entry).not.toHaveProperty("connectedAt");
    expect(entry).not.toHaveProperty("lastSync");
  });

  it("nothing stored: no connectedAt, account, verifiedAt or lastCheck", async () => {
    // Even a check left behind by some other path is not reported for a
    // connection that does not exist.
    const { recordConnectionCheck } = await import("../connectionChecks.js");
    recordConnectionCheck("notion", true);
    const entry = await listed("notion");
    expect(entry.status).toBe("disconnected");
    for (const k of ["connectedAt", "account", "verifiedAt", "lastCheck"]) {
      expect(entry).not.toHaveProperty(k);
    }
  });
});

describe("POST /connections/<id>/test records the outcome", () => {
  function stubNotion(status: number): void {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () =>
        status === 200
          ? new Response(JSON.stringify({ id: "u", object: "user" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : new Response("provider body with details", { status }),
      ),
    );
  }

  beforeEach(async () => {
    await store("notion", {
      accessToken: "secret_example",
      connected_at: "2026-02-02T00:00:00.000Z",
    });
  });

  it("a failing Test records lastCheck with a short reason, no verifiedAt", async () => {
    stubNotion(401);
    const r = await route("POST", "/connections/notion/test");
    expect(r.body.ok).toBe(false);
    const entry = await listed("notion");
    expect(entry.lastCheck).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(entry).not.toHaveProperty("verifiedAt");
    const file = readFileSync(
      join(home, "tokens", "connection-checks.json"),
      "utf-8",
    );
    expect(file).not.toContain("provider body");
    expect(file).not.toContain("secret_example");
  });

  it("a passing Test records verifiedAt and an ok lastCheck", async () => {
    stubNotion(200);
    const r = await route("POST", "/connections/notion/test");
    expect(r.body.ok).toBe(true);
    const entry = await listed("notion");
    expect(entry.lastCheck).toMatchObject({ ok: true });
    expect(entry.verifiedAt).toEqual(expect.any(String));
    expect((entry.lastCheck as { at: string }).at).toBe(entry.verifiedAt);
  });

  it("a later failure keeps the earlier verifiedAt", async () => {
    stubNotion(200);
    await route("POST", "/connections/notion/test");
    const verifiedAt = (await listed("notion")).verifiedAt;
    stubNotion(503);
    await route("POST", "/connections/notion/test");
    const entry = await listed("notion");
    expect(entry.verifiedAt).toBe(verifiedAt);
    // Notion's Test answers 401 for any failed health check, so the reason
    // stays the honest "failed" rather than a guess at the cause.
    expect(entry.lastCheck).toMatchObject({ ok: false, reason: "failed" });
  });

  it("disconnect drops the recorded check", async () => {
    stubNotion(200);
    await route("POST", "/connections/notion/test");
    await route("DELETE", "/connections/notion");
    const { readConnectionChecks } = await import("../connectionChecks.js");
    expect(readConnectionChecks()).not.toHaveProperty("notion");
  });

  it("reconnecting drops the recorded check", async () => {
    stubNotion(200);
    await route("POST", "/connections/notion/test");
    const { recordConnectionCheck, readConnectionChecks } = await import(
      "../connectionChecks.js"
    );
    recordConnectionCheck("gmail", true);
    const { afterCredentialChange } = await import("../connectionChecks.js");
    afterCredentialChange("/connections/notion/connect", { status: 200 });
    expect(readConnectionChecks()).not.toHaveProperty("notion");
    expect(readConnectionChecks()).toHaveProperty("gmail");
    // A rejected callback changed nothing stored, so nothing is dropped.
    afterCredentialChange("/connections/gmail/callback", { status: 400 });
    expect(readConnectionChecks()).toHaveProperty("gmail");
  });
});

describe("checkFromTestResult", () => {
  it("maps a Test result to a closed set of outcomes", async () => {
    const { checkFromTestResult } = await import("../connectionChecks.js");
    const r = (status: number, body: unknown) =>
      checkFromTestResult({ status, body: JSON.stringify(body) });
    expect(r(200, { ok: true })).toEqual({ ok: true });
    // ok:true with an error status is not a pass.
    expect(r(500, { ok: true })).toEqual({ ok: false, reason: "error" });
    expect(r(200, { ok: false, message: "MCP ping failed" })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(r(401, { ok: false, error: "token <body text>" })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(r(500, { ok: false, error: "boom" })).toEqual({
      ok: false,
      reason: "error",
    });
    // Nothing stored ⇒ nothing tested ⇒ nothing recorded.
    expect(r(400, { ok: false, error: "Stripe not connected" })).toBeNull();
    expect(r(200, { ok: false, message: "Not connected" })).toBeNull();
    expect(checkFromTestResult({ status: 200, body: "not json" })).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("a malformed or foreign check file is read as nothing recorded", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(home, "tokens", "connection-checks.json"),
      JSON.stringify({
        notion: { lastCheck: { at: "nope", ok: true }, extra: "x" },
        stripe: {
          verifiedAt: "2026-01-01T00:00:00.000Z",
          lastCheck: {
            at: "2026-01-01T00:00:00.000Z",
            ok: false,
            reason: "body text",
          },
        },
      }),
    );
    const { readConnectionChecks } = await import("../connectionChecks.js");
    expect(readConnectionChecks()).toEqual({
      stripe: {
        verifiedAt: "2026-01-01T00:00:00.000Z",
        lastCheck: { at: "2026-01-01T00:00:00.000Z", ok: false },
      },
    });
  });
});

describe("every Test, connect and callback route goes through the recorder", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "connectorRoutes.ts"),
    "utf-8",
  );
  it("each /test handler result is passed to recordTestOutcome", () => {
    const tests = src.match(/await handle[A-Za-z]+Test\(\)/g) ?? [];
    const recorded =
      src.match(
        /recordTestOutcome\(\s*parsedUrl\.pathname,\s*await handle[A-Za-z]+Test\(\)/g,
      ) ?? [];
    expect(tests.length).toBeGreaterThanOrEqual(40);
    expect(recorded.length).toBe(tests.length);
  });
  it("each callback handler result is passed to afterCredentialChange", () => {
    const cbs = src.match(/await handle[A-Za-z]+Callback\(/g) ?? [];
    const wrapped =
      src.match(
        /afterCredentialChange\(\s*parsedUrl\.pathname,\s*await handle[A-Za-z]+Callback\(/g,
      ) ?? [];
    expect(cbs.length).toBeGreaterThanOrEqual(10);
    expect(wrapped.length).toBe(cbs.length);
  });
  it("each disconnect result is passed to disconnectResponse", () => {
    const ds = src.match(/(?:await )?handle[A-Za-z]+Disconnect\(\)/g) ?? [];
    const wrapped =
      src.match(
        /disconnectResponse\(\s*parsedUrl\.pathname,\s*(?:await )?handle[A-Za-z]+Disconnect\(\)/g,
      ) ?? [];
    expect(ds.length).toBeGreaterThanOrEqual(40);
    expect(wrapped.length).toBe(ds.length);
  });
});

describe("DELETE /connections/<id> reports the revoke outcome", () => {
  function stubFetch(impl: FetchFn): ReturnType<typeof vi.fn<FetchFn>> {
    const m = vi.fn<FetchFn>(impl);
    vi.stubGlobal("fetch", m);
    return m;
  }

  it("gmail: provider accepts → revoked yes, refresh token sent", async () => {
    await store("gmail", GMAIL_TOKENS);
    const f = stubFetch(async () => new Response("{}", { status: 200 }));
    const r = await route("DELETE", "/connections/gmail");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "yes" });
    expect(String(f.mock.calls[0]?.[0])).toContain("token=gm_refresh");
    expect(await stored("gmail")).toBeNull();
  });

  it("gmail: provider refuses → revoked failed, credential still removed", async () => {
    await store("gmail", GMAIL_TOKENS);
    stubFetch(async () => new Response("bad", { status: 400 }));
    const r = await route("DELETE", "/connections/gmail");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "failed" });
    expect(await stored("gmail")).toBeNull();
  });

  it("gmail: network error → revoked failed, credential still removed", async () => {
    await store("gmail", GMAIL_TOKENS);
    stubFetch(async () => {
      throw new Error("offline");
    });
    const r = await route("DELETE", "/connections/gmail");
    expect(r.body.revoked).toBe("failed");
    expect(await stored("gmail")).toBeNull();
  });

  it.each([
    ["google-calendar", "google-calendar"],
    ["google-drive", "google-drive"],
    ["google-docs", "google-docs"],
  ])("%s: refresh token revoked, outcome reported", async (id, key) => {
    await store(key, {
      access_token: "g_access",
      refresh_token: "g_refresh",
      expiry_date: Date.now() + 3_600_000,
      calendar_id: "primary",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    const f = stubFetch(async () => new Response("{}", { status: 200 }));
    const r = await route("DELETE", `/connections/${id}`);
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "yes" });
    expect(String(f.mock.calls[0]?.[0])).toContain("token=g_refresh");
    expect(await stored(key)).toBeNull();
  });

  it("slack: provider says ok:false → failed", async () => {
    await store("slack", {
      access_token: "xoxb-example",
      team_id: "T0",
      team_name: "example-team",
      bot_user_id: "B0",
      connected_at: "2026-03-03T00:00:00.000Z",
    });
    stubFetch(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 200,
        }),
    );
    const r = await route("DELETE", "/connections/slack");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "failed" });
    expect(await stored("slack")).toBeNull();
  });

  it("slack: provider confirms → yes", async () => {
    await store("slack", {
      access_token: "xoxb-example",
      team_id: "T0",
      team_name: "example-team",
      bot_user_id: "B0",
      connected_at: "2026-03-03T00:00:00.000Z",
    });
    stubFetch(
      async () =>
        new Response(JSON.stringify({ ok: true, revoked: true }), {
          status: 200,
        }),
    );
    const r = await route("DELETE", "/connections/slack");
    expect(r.body.revoked).toBe("yes");
  });

  it("asana: revokes the refresh token at the Asana revoke endpoint", async () => {
    vi.stubEnv("ASANA_CLIENT_ID", "asana-client");
    vi.stubEnv("ASANA_CLIENT_SECRET", "asana-secret");
    await store("asana", {
      access_token: "as_access",
      refresh_token: "as_refresh",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    const f = stubFetch(async () => new Response("", { status: 200 }));
    const r = await route("DELETE", "/connections/asana");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "yes" });
    expect(String(f.mock.calls[0]?.[0])).toBe(
      "https://app.asana.com/-/oauth_revoke",
    );
    const sent = new URLSearchParams(String(f.mock.calls[0]?.[1]?.body));
    expect(sent.get("token")).toBe("as_refresh");
    expect(sent.get("client_id")).toBe("asana-client");
    expect(await stored("asana")).toBeNull();
  });

  it("asana: revoke fails → failed, credential still removed", async () => {
    vi.stubEnv("ASANA_CLIENT_ID", "asana-client");
    vi.stubEnv("ASANA_CLIENT_SECRET", "asana-secret");
    await store("asana", {
      access_token: "as_access",
      refresh_token: "as_refresh",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    stubFetch(async () => new Response("no", { status: 500 }));
    const r = await route("DELETE", "/connections/asana");
    expect(r.body.revoked).toBe("failed");
    expect(await stored("asana")).toBeNull();
  });

  it("salesforce: revokes the refresh token", async () => {
    await store("salesforce", {
      access_token: "sf_access",
      refresh_token: "sf_refresh",
      instance_url: "https://example.my.salesforce.com",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    const f = stubFetch(async () => new Response("", { status: 200 }));
    const r = await route("DELETE", "/connections/salesforce");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "yes" });
    expect(
      f.mock.calls.some((c) => String(c[0]).includes("token=sf_refresh")),
    ).toBe(true);
    expect(await stored("salesforce")).toBeNull();
  });

  it("github: no provider revoke → unsupported", async () => {
    await store("github-mcp", {
      vendor: "github",
      client_id: "c",
      access_token: "gh_stored",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    stubFetch(async () => {
      throw new Error("must not be called");
    });
    const r = await route("DELETE", "/connections/github");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "unsupported" });
  });

  it("sentry: revoke endpoint refuses → failed, credential removed", async () => {
    await store("sentry-mcp", {
      vendor: "sentry",
      client_id: "c",
      access_token: "s_access",
      refresh_token: "s_refresh",
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    stubFetch(async () => new Response("no", { status: 400 }));
    const r = await route("DELETE", "/connections/sentry");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "failed" });
    const { loadTokenFile } = await import("../mcpOAuth.js");
    expect(loadTokenFile("sentry")).toBeNull();
  });

  it("a paste-token connector has no provider revoke → unsupported", async () => {
    await store("notion", {
      accessToken: "secret_example",
      connected_at: "2026-02-02T00:00:00.000Z",
    });
    const r = await route("DELETE", "/connections/notion");
    expect(r.body).toEqual({ ok: true, removed: true, revoked: "unsupported" });
  });

  it("nothing stored on a revoking connector → no revoked claim", async () => {
    stubFetch(async () => {
      throw new Error("must not be called");
    });
    const r = await route("DELETE", "/connections/gmail");
    expect(r.body).toEqual({ ok: true, removed: true });
  });
});

describe("REVOKING_CONNECTORS matches the disconnect handlers", () => {
  it("lists exactly the connectors whose disconnect attempts a revoke", async () => {
    const { REVOKING_CONNECTORS } = await import("../connectionChecks.js");
    const { CONNECTORS } = await import("../connectorRegistry.js");
    const dir = join(__dirname, "..");
    const fileFor: Record<string, string> = {
      "google-calendar": "googleCalendar",
      "google-drive": "googleDrive",
      "google-docs": "googleDocs",
    };
    const revoking = new Set<string>();
    for (const c of CONNECTORS) {
      const name = fileFor[c.id] ?? c.id;
      const path = join(dir, `${name}.ts`);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf-8");
      const m =
        /export async function handle[A-Za-z]*Disconnect\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(
          src,
        );
      if (m?.[1] && /revoke/i.test(m[1].replace(/\/\/.*$/gm, ""))) {
        revoking.add(c.id);
      }
    }
    expect([...revoking].sort()).toEqual([...REVOKING_CONNECTORS].sort());
  });
});
