/**
 * OAuth 2.0 server hardening — three findings from the 2026-10-01 sweep.
 *
 * 1. The wrong-bridge-token RETRY render of the approval page must carry the
 *    same anti-framing headers the GET render does. The nonce is flow-keyed
 *    and client-bound, not session-bound, so a cross-site POST into an iframe
 *    with a wrong token produced a framable token-entry form bound to the
 *    attacker's client.
 * 2. The /oauth/register and /oauth/token limiters must key on the resolved
 *    client IP, not the raw socket peer. Remote deployment REQUIRES a reverse
 *    proxy, behind which every client shares one socket address — one
 *    attacker 429s everyone's token exchange.
 * 3. A CIMD client_id (https URL) must count against the registered-client
 *    cap. It was inserted into the same map the cap counts, from an
 *    unauthenticated GET, subject to neither the cap nor the limiter.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthServerImpl } from "../oauth.js";

const ISSUER = "https://bridge.example.com";
const BRIDGE_TOKEN = crypto.randomBytes(32).toString("hex");
const CLIENT_ID = "test-client";
const REDIRECT_URI = "http://localhost:3000/callback";

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, hdrs?: Record<string, string>) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(hdrs ?? {}))
      this.headers[k.toLowerCase()] = v;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  getHeader(k: string) {
    return this.headers[k.toLowerCase()];
  }
  end(body?: string) {
    this.body = body ?? "";
    return this;
  }
}

function getReq(
  url: string,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  return {
    method: "GET",
    url,
    headers: {},
    socket: { remoteAddress },
  } as unknown as http.IncomingMessage;
}

function postReq(
  body: string,
  contentType: string,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  const stream = Readable.from([Buffer.from(body, "utf-8")]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "content-type": contentType },
    socket: { remoteAddress },
  }) as unknown as http.IncomingMessage;
}

function res(): { r: MockResponse; sr: http.ServerResponse } {
  const r = new MockResponse();
  return { r, sr: r as unknown as http.ServerResponse };
}

type Opts = NonNullable<ConstructorParameters<typeof OAuthServerImpl>[2]>;

const live: OAuthServerImpl[] = [];
function make(opts?: Opts, withClient = true): OAuthServerImpl {
  const oauth = new OAuthServerImpl(BRIDGE_TOKEN, ISSUER, opts);
  live.push(oauth);
  if (withClient) {
    (oauth as any).registeredClients.set(CLIENT_ID, {
      redirectUris: [REDIRECT_URI],
      issuedAt: Date.now(),
    });
  }
  return oauth;
}
afterEach(() => {
  for (const o of live.splice(0)) o.destroy();
});

function challenge(): string {
  return crypto
    .createHash("sha256")
    .update(crypto.randomBytes(32))
    .digest("base64url");
}

async function primeNonce(
  oauth: OAuthServerImpl,
  ch: string,
): Promise<{ nonce: string; flowId: string }> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: ch,
    code_challenge_method: "S256",
    scope: "mcp",
  });
  const { r, sr } = res();
  await oauth.handleAuthorize(getReq(`/oauth/authorize?${params}`), sr);
  expect(r.statusCode).toBe(200);
  const nonces = (oauth as any).csrfNonces as Map<
    string,
    { nonce: string; clientId: string }
  >;
  const [flowId, entry] = [...nonces.entries()].find(
    ([, v]) => v.clientId === CLIENT_ID,
  ) ?? ["", undefined];
  if (!entry) throw new Error("nonce not primed");
  return { nonce: entry.nonce, flowId };
}

// ── 1. Anti-framing headers on the retry render ──────────────────────────────

describe("approval page — anti-framing headers on BOTH renders", () => {
  const expectFramingHeaders = (r: MockResponse) => {
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  };

  it("GET render carries them (control — already true)", async () => {
    const oauth = make();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge(),
      code_challenge_method: "S256",
      scope: "mcp",
    });
    const { r, sr } = res();
    await oauth.handleAuthorize(getReq(`/oauth/authorize?${params}`), sr);
    expect(r.statusCode).toBe(200);
    expectFramingHeaders(r);
  });

  it("wrong-bridge-token retry render carries them too", async () => {
    const oauth = make();
    const ch = challenge();
    const { nonce, flowId } = await primeNonce(oauth, ch);
    const form = new URLSearchParams({
      action: "approve",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: ch,
      bridge_token: "not-the-bridge-token",
      scope: "mcp",
      csrf_nonce: nonce,
      flow_id: flowId,
    });
    const { r, sr } = res();
    await oauth.handleAuthorize(
      postReq(form.toString(), "application/x-www-form-urlencoded"),
      sr,
    );
    // It IS the retry page (200 + a token field), not a redirect or error.
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("bridge_token");
    expectFramingHeaders(r);
  });
});

// ── 2. Limiters key on the resolved client IP ────────────────────────────────

describe("rate limiters key on the injected clientIp resolver", () => {
  const registerBody = JSON.stringify({
    redirect_uris: ["https://app.example.test/cb"],
  });

  it("/oauth/register: one resolved client behind many socket peers is ONE bucket", async () => {
    // Every request arrives from a different socket address (as if the
    // limiter were keyed on the peer, these would never collide) but the
    // resolver says they are all the same client.
    const oauth = make({ clientIp: () => "203.0.113.7" }, false);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const { r, sr } = res();
      await oauth.handleRegister(
        postReq(registerBody, "application/json", `10.0.0.${i + 1}`),
        sr,
      );
      statuses.push(r.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("/oauth/register: distinct resolved clients on ONE socket peer are separate buckets", async () => {
    // The proxy case: every client shares the proxy's socket address. The
    // limiter must not let client A's burst 429 client B.
    let who = "a";
    const oauth = make({ clientIp: () => who }, false);
    for (let i = 0; i < 10; i++) {
      const { sr } = res();
      await oauth.handleRegister(postReq(registerBody, "application/json"), sr);
    }
    who = "b";
    const { r, sr } = res();
    await oauth.handleRegister(postReq(registerBody, "application/json"), sr);
    expect(r.statusCode).toBe(201);
  });

  it("/oauth/token: keyed on the resolver as well", async () => {
    const oauth = make({ clientIp: () => "203.0.113.7" });
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code: "bogus",
      code_verifier: "bogus",
    }).toString();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const { r, sr } = res();
      await oauth.handleToken(
        postReq(body, "application/x-www-form-urlencoded", `10.0.0.${i + 1}`),
        sr,
      );
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it("resolver returning null falls back to the socket peer", async () => {
    const oauth = make({ clientIp: () => null }, false);
    for (let i = 0; i < 10; i++) {
      const { sr } = res();
      await oauth.handleRegister(
        postReq(registerBody, "application/json", "198.51.100.1"),
        sr,
      );
    }
    const { r, sr } = res();
    await oauth.handleRegister(
      postReq(registerBody, "application/json", "198.51.100.1"),
      sr,
    );
    expect(r.statusCode).toBe(429);
  });
});

// ── 3. CIMD registration counts against the client cap ───────────────────────

describe("CIMD client_id is subject to the registered-client cap", () => {
  const CIMD_CLIENT = "https://cimd.example.test/client.json";
  const CIMD_REDIRECT = "https://cimd.example.test/cb";

  function seed(oauth: OAuthServerImpl, n: number): Map<string, unknown> {
    const clients = (oauth as any).registeredClients as Map<string, unknown>;
    for (let i = 0; i < n; i++)
      clients.set(`seed-${i}`, {
        redirectUris: ["https://seed.example.test/cb"],
        issuedAt: Date.now(),
      });
    // Never hit the network: stub the CIMD fetch.
    (oauth as any).fetchCimd = async () => [CIMD_REDIRECT];
    return clients;
  }

  const authorizeUrl = () =>
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: CIMD_CLIENT,
      redirect_uri: CIMD_REDIRECT,
      code_challenge: challenge(),
      code_challenge_method: "S256",
      scope: "mcp",
    })}`;

  it("at the cap, an unauthenticated CIMD GET is refused and registers nothing", async () => {
    const oauth = make(undefined, false);
    const clients = seed(oauth, 500);
    const { r, sr } = res();
    await oauth.handleAuthorize(getReq(authorizeUrl()), sr);
    expect(r.statusCode).not.toBe(200);
    expect(clients.size).toBe(500);
    expect(clients.has(CIMD_CLIENT)).toBe(false);
  });

  it("below the cap, the same GET succeeds and pins the client (control)", async () => {
    const oauth = make(undefined, false);
    const clients = seed(oauth, 499);
    const { r, sr } = res();
    await oauth.handleAuthorize(getReq(authorizeUrl()), sr);
    expect(r.statusCode).toBe(200);
    expect(clients.has(CIMD_CLIENT)).toBe(true);
  });

  it("an already-pinned CIMD client is still served at the cap (no re-registration needed)", async () => {
    const oauth = make(undefined, false);
    const clients = seed(oauth, 499);
    clients.set(CIMD_CLIENT, {
      redirectUris: [CIMD_REDIRECT],
      issuedAt: Date.now(),
    });
    expect(clients.size).toBe(500);
    const { r, sr } = res();
    await oauth.handleAuthorize(getReq(authorizeUrl()), sr);
    expect(r.statusCode).toBe(200);
  });
});
