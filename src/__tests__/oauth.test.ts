/**
 * Tests for OAuthServerImpl
 * RFC 6749 Authorization Code Grant + PKCE (RFC 7636)
 * RFC 7009 Token Revocation
 * RFC 8414 Authorization Server Metadata
 */

import crypto from "node:crypto";
import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { OAuthServerImpl } from "../oauth.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ISSUER = "https://bridge.example.com";
const BRIDGE_TOKEN = crypto.randomBytes(32).toString("hex");
const CLIENT_ID = "test-client";
const REDIRECT_URI = "http://localhost:3000/callback";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOAuth() {
  return new OAuthServerImpl(BRIDGE_TOKEN, ISSUER);
}

function makeVerifier() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  writeHead(status: number, hdrs?: Record<string, string>) {
    this.statusCode = status;
    this.headersSent = true;
    // Normalise to lowercase so headers["location"] always works
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
    return this;
  }
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  getHeader(k: string) { return this.headers[k.toLowerCase()]; }
  end(body?: string) { this.body = body ?? ""; return this; }
  json(): unknown { return JSON.parse(this.body || "{}"); }
}

function makeGetReq(url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method: "GET", url, headers } as unknown as http.IncomingMessage;
}

function makePostReq(body: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const stream = Readable.from([Buffer.from(body, "utf-8")]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  }) as unknown as http.IncomingMessage;
}

/** POST to /oauth/authorize with action=approve, returns the issued code */
async function issueCode(
  oauth: OAuthServerImpl,
  overrides: Record<string, string> = {},
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = makeVerifier();
  const form = new URLSearchParams({
    action: "approve",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    scope: "mcp",
    state: "s1",
    ...overrides,
  });
  const req = makePostReq(form.toString());
  const res = new MockResponse();
  await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
  const location = new URL(res.headers["location"] ?? "http://invalid");
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`No code issued. Status=${res.statusCode} Location=${res.headers["location"]}`);
  return { code, verifier };
}

async function issueToken(
  oauth: OAuthServerImpl,
  code: string,
  verifier: string,
  overrides: Record<string, string> = {},
): Promise<{ res: MockResponse; data: Record<string, unknown> }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
    ...overrides,
  }).toString();
  const req = makePostReq(body);
  const res = new MockResponse();
  await oauth.handleToken(req, res as unknown as http.ServerResponse);
  return { res, data: res.json() as Record<string, unknown> };
}

// ── Discovery ─────────────────────────────────────────────────────────────────

describe("OAuthServerImpl — discovery", () => {
  it("returns RFC 8414 metadata document", () => {
    const oauth = makeOAuth();
    const res = new MockResponse();
    oauth.handleDiscovery(res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.response_types_supported).toContain("code");
  });
});

// ── GET /oauth/authorize ──────────────────────────────────────────────────────

describe("OAuthServerImpl — GET /oauth/authorize", () => {
  it("renders 200 HTML approval page with valid params and bridge token", () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "abc", code_challenge: challenge, code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, { authorization: `Bearer ${BRIDGE_TOKEN}` });
    const res = new MockResponse();
    oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Authorize");
    expect(res.body).toContain(CLIENT_ID);
  });

  it("returns 401 without bridge token", () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "abc", code_challenge: challenge, code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`);
    const res = new MockResponse();
    oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when response_type is not code", () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "token", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "abc", code_challenge: challenge, code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, { authorization: `Bearer ${BRIDGE_TOKEN}` });
    const res = new MockResponse();
    oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when code_challenge is missing", () => {
    const oauth = makeOAuth();
    const params = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "abc", code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, { authorization: `Bearer ${BRIDGE_TOKEN}` });
    const res = new MockResponse();
    oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when code_challenge_method is plain", () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "abc", code_challenge: challenge, code_challenge_method: "plain",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, { authorization: `Bearer ${BRIDGE_TOKEN}` });
    const res = new MockResponse();
    oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("accepts bridge token via ?bridge_token= query param", () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      state: "abc", code_challenge: challenge, code_challenge_method: "S256",
      bridge_token: BRIDGE_TOKEN,
    });
    const req = makeGetReq(`/oauth/authorize?${params}`);
    const res = new MockResponse();
    oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
  });
});

// ── POST /oauth/authorize ─────────────────────────────────────────────────────

describe("OAuthServerImpl — POST /oauth/authorize", () => {
  it("issues code via 302 redirect on approve", async () => {
    const oauth = makeOAuth();
    const { code } = await issueCode(oauth);
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(16);
  });

  it("redirects with error=access_denied on deny", async () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const form = new URLSearchParams({
      action: "deny", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      code_challenge: challenge, scope: "mcp", state: "s1",
    });
    const req = makePostReq(form.toString());
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers["location"] ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("returns 400 for missing parameters", async () => {
    const oauth = makeOAuth();
    const req = makePostReq("action=approve");
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /oauth/token ─────────────────────────────────────────────────────────

describe("OAuthServerImpl — POST /oauth/token", () => {
  it("issues access token for valid code + verifier", async () => {
    const oauth = makeOAuth();
    const { code, verifier } = await issueCode(oauth);
    const { res, data } = await issueToken(oauth, code, verifier);
    expect(res.statusCode).toBe(200);
    expect(typeof data.access_token).toBe("string");
    expect(data.token_type).toBe("Bearer");
    expect(typeof data.expires_in).toBe("number");
    expect(data.scope).toBe("mcp");
  });

  it("rejects wrong code_verifier", async () => {
    const oauth = makeOAuth();
    const { code } = await issueCode(oauth);
    const { res, data } = await issueToken(oauth, code, "not-the-right-verifier-aaa");
    expect(res.statusCode).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects code reuse — single-use enforcement", async () => {
    const oauth = makeOAuth();
    const { code, verifier } = await issueCode(oauth);
    const first = await issueToken(oauth, code, verifier);
    expect(first.res.statusCode).toBe(200);
    const second = await issueToken(oauth, code, verifier);
    expect(second.res.statusCode).toBe(400);
    expect(second.data.error).toBe("invalid_grant");
  });

  it("rejects unknown code", async () => {
    const oauth = makeOAuth();
    const { res, data } = await issueToken(oauth, "fake-code", "fake-verifier");
    expect(res.statusCode).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects unsupported grant_type", async () => {
    const oauth = makeOAuth();
    const req = makePostReq("grant_type=implicit&client_id=x&redirect_uri=x&code=x&code_verifier=x");
    const res = new MockResponse();
    await oauth.handleToken(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe("unsupported_grant_type");
  });

  it("rejects client_id mismatch", async () => {
    const oauth = makeOAuth();
    const { code, verifier } = await issueCode(oauth);
    const { res, data } = await issueToken(oauth, code, verifier, { client_id: "wrong-client" });
    expect(res.statusCode).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects missing required parameters", async () => {
    const oauth = makeOAuth();
    const req = makePostReq("grant_type=authorization_code");
    const res = new MockResponse();
    await oauth.handleToken(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe("invalid_request");
  });
});

// ── POST /oauth/revoke ────────────────────────────────────────────────────────

describe("OAuthServerImpl — POST /oauth/revoke", () => {
  it("revokes a valid token and it becomes unusable", async () => {
    const oauth = makeOAuth();
    const { code, verifier } = await issueCode(oauth);
    const { data } = await issueToken(oauth, code, verifier);
    const token = data.access_token as string;

    expect(oauth.resolveBearerToken(token)).toBe(BRIDGE_TOKEN);

    const req = makePostReq(`token=${encodeURIComponent(token)}`);
    const res = new MockResponse();
    await oauth.handleRevoke(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(oauth.resolveBearerToken(token)).toBeNull();
  });

  it("returns 200 for unknown token (RFC 7009)", async () => {
    const oauth = makeOAuth();
    const req = makePostReq("token=totally-unknown-token");
    const res = new MockResponse();
    await oauth.handleRevoke(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
  });
});

// ── resolveBearerToken ────────────────────────────────────────────────────────

describe("OAuthServerImpl — resolveBearerToken", () => {
  it("returns null for unknown token", () => {
    expect(makeOAuth().resolveBearerToken("not-real")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(makeOAuth().resolveBearerToken("")).toBeNull();
  });

  it("returns bridge token for a valid issued access token", async () => {
    const oauth = makeOAuth();
    const { code, verifier } = await issueCode(oauth);
    const { data } = await issueToken(oauth, code, verifier);
    expect(oauth.resolveBearerToken(data.access_token as string)).toBe(BRIDGE_TOKEN);
  });

  it("does NOT resolve the static bridge token itself — that path is in server.ts", () => {
    expect(makeOAuth().resolveBearerToken(BRIDGE_TOKEN)).toBeNull();
  });
});
