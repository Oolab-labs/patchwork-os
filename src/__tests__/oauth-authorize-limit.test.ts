/**
 * /oauth/authorize was the one unauthenticated OAuth endpoint with no rate
 * limit (security sweep 2026-10-01, L11). Every GET mints a CSRF nonce that
 * lives 10 minutes, and every POST with a wrong bridge token re-renders the
 * token form — so a client could mint nonces and probe tokens without bound,
 * and nothing recorded a wrong-token attempt anywhere.
 *
 * Brute force of the token itself is infeasible (a UUID), so this is about
 * bounding resource use and making attempts visible, not about entropy.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthServerImpl } from "../oauth.js";

const ISSUER = "https://bridge.example.test";
const BRIDGE_TOKEN = crypto.randomBytes(32).toString("hex");
const CLIENT_ID = "test-client";
const REDIRECT_URI = "http://localhost:3000/callback";
const CHALLENGE = crypto
  .createHash("sha256")
  .update(crypto.randomBytes(32))
  .digest("base64url");

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
const res = () => {
  const r = new MockResponse();
  return { r, sr: r as unknown as http.ServerResponse };
};
const getReq = (url: string) =>
  ({
    method: "GET",
    url,
    headers: {},
    socket: { remoteAddress: "10.0.0.1" },
  }) as unknown as http.IncomingMessage;
const postReq = (form: URLSearchParams) =>
  Object.assign(Readable.from([Buffer.from(form.toString(), "utf-8")]), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    socket: { remoteAddress: "10.0.0.1" },
  }) as unknown as http.IncomingMessage;

const live: OAuthServerImpl[] = [];
function make(clientIp: () => string): OAuthServerImpl {
  const o = new OAuthServerImpl(BRIDGE_TOKEN, ISSUER, { clientIp });
  live.push(o);
  (
    o as unknown as {
      registeredClients: Map<string, unknown>;
    }
  ).registeredClients.set(CLIENT_ID, {
    redirectUris: [REDIRECT_URI],
    issuedAt: Date.now(),
  });
  return o;
}
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const o of live.splice(0)) o.destroy();
  vi.restoreAllMocks();
});

const authorizeUrl = `/oauth/authorize?${new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  scope: "mcp",
})}`;

async function get(o: OAuthServerImpl) {
  const { r, sr } = res();
  await o.handleAuthorize(getReq(authorizeUrl), sr);
  return r;
}

describe("/oauth/authorize — per-client rate limit", () => {
  it("answers 429 once one client exceeds the window, and mints no further nonce", async () => {
    const o = make(() => "203.0.113.7");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await get(o)).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const nonces = (o as unknown as { csrfNonces: Map<string, unknown> })
      .csrfNonces;
    expect(nonces.size).toBe(30);
  });

  it("keeps distinct clients in separate buckets (keyed by the resolved client IP)", async () => {
    let who = "a";
    const o = make(() => who);
    for (let i = 0; i < 30; i++) await get(o);
    who = "b";
    expect((await get(o)).statusCode).toBe(200);
  });

  it("counts POSTs (where a token would be guessed) against the same bucket", async () => {
    const o = make(() => "203.0.113.7");
    for (let i = 0; i < 30; i++) await get(o);
    const form = new URLSearchParams({
      action: "approve",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      bridge_token: "wrong",
      scope: "mcp",
      csrf_nonce: "x",
      flow_id: "y",
    });
    const { r, sr } = res();
    await o.handleAuthorize(postReq(form), sr);
    expect(r.statusCode).toBe(429);
  });
});

describe("/oauth/authorize — wrong bridge token is recorded", () => {
  it("warns on a wrong token, naming the client but never the presented value", async () => {
    const o = make(() => "203.0.113.7");
    await get(o);
    const nonces = (
      o as unknown as {
        csrfNonces: Map<string, { nonce: string; clientId: string }>;
      }
    ).csrfNonces;
    const [flowId, entry] = [...nonces.entries()][0] ?? ["", undefined];
    if (!entry) throw new Error("no nonce");
    const presented = "presented-wrong-token-value";
    const form = new URLSearchParams({
      action: "approve",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      bridge_token: presented,
      scope: "mcp",
      csrf_nonce: entry.nonce,
      flow_id: flowId,
    });
    const { sr } = res();
    await o.handleAuthorize(postReq(form), sr);
    const logged = warnSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(logged).toMatch(/wrong bridge token/i);
    expect(logged).toContain(CLIENT_ID);
    expect(logged).not.toContain(presented);
  });
});
