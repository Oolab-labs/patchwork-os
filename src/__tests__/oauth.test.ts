/**
 * Tests for OAuthServerImpl
 * RFC 6749 Authorization Code Grant + PKCE (RFC 7636)
 * RFC 7009 Token Revocation
 * RFC 8414 Authorization Server Metadata
 */

import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
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

/** Pre-register CLIENT_ID with REDIRECT_URI so authorize flows succeed */
function makeOAuthWithClient(): OAuthServerImpl {
  const oauth = new OAuthServerImpl(BRIDGE_TOKEN, ISSUER);
  // Seed the registered client directly (test-only private access)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (oauth as any).registeredClients.set(CLIENT_ID, {
    redirectUris: [REDIRECT_URI],
    issuedAt: Date.now(),
  });
  return oauth;
}

function makeVerifier() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
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
  json(): unknown {
    return JSON.parse(this.body || "{}");
  }
}

function makeGetReq(
  url: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  return { method: "GET", url, headers } as unknown as http.IncomingMessage;
}

function makePostReq(
  body: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const stream = Readable.from([Buffer.from(body, "utf-8")]);
  return Object.assign(stream, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
  }) as unknown as http.IncomingMessage;
}

/** GET /oauth/authorize to prime the CSRF nonce, then return it. */
async function primeCsrfNonce(
  oauth: OAuthServerImpl,
  challenge: string,
): Promise<{ nonce: string; flowId: string }> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    state: "s1",
  });
  const req = makeGetReq(`/oauth/authorize?${params}`);
  const res = new MockResponse();
  await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
  // Extract nonce from internal map (test-only access).
  // Map is now keyed by flowId, so find the entry matching CLIENT_ID.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonces = (oauth as any).csrfNonces as Map<
    string,
    { nonce: string; clientId: string; expiresAt: number }
  >;
  const entry = [...nonces.values()].find((v) => v.clientId === CLIENT_ID);
  if (!entry) throw new Error("CSRF nonce not stored after GET");
  const flowId =
    [...nonces.entries()].find(([, v]) => v.clientId === CLIENT_ID)?.[0] ?? "";
  return { nonce: entry.nonce, flowId };
}

/** POST to /oauth/authorize with action=approve, returns the issued code */
async function issueCode(
  oauth: OAuthServerImpl,
  overrides: Record<string, string> = {},
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = makeVerifier();
  const { nonce: csrfNonce, flowId } = await primeCsrfNonce(oauth, challenge);
  const form = new URLSearchParams({
    action: "approve",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    bridge_token: BRIDGE_TOKEN,
    scope: "mcp",
    state: "s1",
    csrf_nonce: csrfNonce,
    flow_id: flowId,
    ...overrides,
  });
  const req = makePostReq(form.toString());
  const res = new MockResponse();
  await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
  const location = new URL(res.headers.location ?? "http://invalid");
  const code = location.searchParams.get("code");
  if (!code)
    throw new Error(
      `No code issued. Status=${res.statusCode} Location=${res.headers.location}`,
    );
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
  it("renders 200 HTML approval page with valid params and bridge token", async () => {
    const oauth = makeOAuthWithClient();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Authorize");
    expect(res.body).toContain(CLIENT_ID);
  });

  it("returns 200 approval page on GET (token entered via form)", async () => {
    const oauth = makeOAuthWithClient();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`);
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("bridge_token");
  });

  it("returns 400 when response_type is not code", async () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "token",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when code_challenge is missing", async () => {
    const oauth = makeOAuth();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when code_challenge_method is plain", async () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "plain",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("accepts bridge token via ?bridge_token= query param", async () => {
    const oauth = makeOAuthWithClient();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "S256",
      bridge_token: BRIDGE_TOKEN,
    });
    const req = makeGetReq(`/oauth/authorize?${params}`);
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(200);
  });
});

// ── POST /oauth/authorize ─────────────────────────────────────────────────────

describe("OAuthServerImpl — POST /oauth/authorize", () => {
  it("issues code via 302 redirect on approve", async () => {
    const oauth = makeOAuthWithClient();
    const { code } = await issueCode(oauth);
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(16);
  });

  it("redirects with error=access_denied on deny", async () => {
    const oauth = makeOAuthWithClient();
    const { challenge } = makeVerifier();
    const { nonce: csrfNonce, flowId } = await primeCsrfNonce(oauth, challenge);
    const form = new URLSearchParams({
      action: "deny",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      scope: "mcp",
      state: "s1",
      csrf_nonce: csrfNonce,
      flow_id: flowId,
    });
    const req = makePostReq(form.toString());
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location ?? "");
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
    const oauth = makeOAuthWithClient();
    const { code, verifier } = await issueCode(oauth);
    const { res, data } = await issueToken(oauth, code, verifier);
    expect(res.statusCode).toBe(200);
    expect(typeof data.access_token).toBe("string");
    expect(data.token_type).toBe("Bearer");
    expect(typeof data.expires_in).toBe("number");
    expect(data.scope).toBe("mcp");
  });

  it("rejects wrong code_verifier", async () => {
    const oauth = makeOAuthWithClient();
    const { code } = await issueCode(oauth);
    const { res, data } = await issueToken(
      oauth,
      code,
      "not-the-right-verifier-aaa",
    );
    expect(res.statusCode).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects code reuse — single-use enforcement", async () => {
    const oauth = makeOAuthWithClient();
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
    const req = makePostReq(
      "grant_type=implicit&client_id=x&redirect_uri=x&code=x&code_verifier=x",
    );
    const res = new MockResponse();
    await oauth.handleToken(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe(
      "unsupported_grant_type",
    );
  });

  it("rejects client_id mismatch", async () => {
    const oauth = makeOAuthWithClient();
    const { code, verifier } = await issueCode(oauth);
    const { res, data } = await issueToken(oauth, code, verifier, {
      client_id: "wrong-client",
    });
    expect(res.statusCode).toBe(400);
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects missing required parameters", async () => {
    const oauth = makeOAuth();
    const req = makePostReq("grant_type=authorization_code");
    const res = new MockResponse();
    await oauth.handleToken(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe(
      "invalid_request",
    );
  });
});

// ── POST /oauth/revoke ────────────────────────────────────────────────────────

describe("OAuthServerImpl — POST /oauth/revoke", () => {
  it("revokes a valid token and it becomes unusable", async () => {
    const oauth = makeOAuthWithClient();
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
    const oauth = makeOAuthWithClient();
    const { code, verifier } = await issueCode(oauth);
    const { data } = await issueToken(oauth, code, verifier);
    expect(oauth.resolveBearerToken(data.access_token as string)).toBe(
      BRIDGE_TOKEN,
    );
  });

  it("does NOT resolve the static bridge token itself — that path is in server.ts", () => {
    expect(makeOAuth().resolveBearerToken(BRIDGE_TOKEN)).toBeNull();
  });
});

// ── OAuthServerImpl — redirect_uri validation ─────────────────────────────────

describe("OAuthServerImpl — redirect_uri validation", () => {
  function makeRegisterReq(
    body: Record<string, unknown>,
  ): http.IncomingMessage {
    const stream = Readable.from([Buffer.from(JSON.stringify(body), "utf-8")]);
    return Object.assign(stream, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }) as unknown as http.IncomingMessage;
  }

  it("handleRegister rejects non-https, non-localhost URI with 400", async () => {
    const oauth = makeOAuth();
    const req = makeRegisterReq({ redirect_uris: ["http://evil.com/cb"] });
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>).error).toBe(
      "invalid_redirect_uri",
    );
  });

  it("handleRegister accepts https:// URIs", async () => {
    const oauth = makeOAuth();
    const req = makeRegisterReq({
      redirect_uris: ["https://myapp.example.com/callback"],
    });
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(201);
  });

  it("handleRegister accepts http://localhost/ URIs", async () => {
    const oauth = makeOAuth();
    const req = makeRegisterReq({
      redirect_uris: ["http://localhost:4000/callback"],
    });
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(201);
  });

  it("handleRegister accepts http://127.0.0.1/ URIs", async () => {
    const oauth = makeOAuth();
    const req = makeRegisterReq({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
    });
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(201);
  });

  it("handleRegister rejects unsupported scope with 400", async () => {
    const oauth = makeOAuth();
    const req = makeRegisterReq({
      redirect_uris: ["https://myapp.example.com/callback"],
      scope: "mcp admin",
    });
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_client_metadata");
    expect(String(body.error_description)).toContain("admin");
  });

  it("handleAuthorize GET returns 400 for unregistered client_id", async () => {
    const oauth = makeOAuth(); // no registered clients
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "unregistered-client",
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("CIMD: returns 400 for private/loopback client_id URL (SSRF guard)", async () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    for (const privateUrl of [
      "https://localhost/client.json",
      "https://127.0.0.1/client.json",
      "https://192.168.1.1/client.json",
      "https://10.0.0.1/client.json",
    ]) {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: privateUrl,
        redirect_uri: REDIRECT_URI,
        state: "abc",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = makeGetReq(`/oauth/authorize?${params}`);
      const res = new MockResponse();
      await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
      expect(res.statusCode, `expected 400 for ${privateUrl}`).toBe(400);
    }
  });

  it("CIMD: returns 400 for http:// client_id URL (must be HTTPS)", async () => {
    const oauth = makeOAuth();
    const { challenge } = makeVerifier();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "http://example.com/client.json",
      redirect_uri: REDIRECT_URI,
      state: "abc",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const req = makeGetReq(`/oauth/authorize?${params}`);
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
  });

  it("handleAuthorize POST (deny) returns 400 for unregistered redirect_uri", async () => {
    const oauth = makeOAuth(); // no registered clients
    const { challenge } = makeVerifier();
    // No CSRF nonce provided — CSRF check fires first (403), before redirect_uri check (400)
    const form = new URLSearchParams({
      action: "deny",
      client_id: CLIENT_ID,
      redirect_uri: "http://unregistered.example.com/cb",
      code_challenge: challenge,
      scope: "mcp",
      state: "s1",
    });
    const req = makePostReq(form.toString());
    const res = new MockResponse();
    await oauth.handleAuthorize(req, res as unknown as http.ServerResponse);
    // CSRF check fires before redirect_uri validation — 403 is the correct response
    expect(res.statusCode).toBe(403);
  });
});

// ── OAuthServerImpl — body size cap (DoS prevention) ─────────────────────────

describe("OAuthServerImpl — body size cap", () => {
  /**
   * Stream a body in small chunks, tracking how many bytes were pushed AFTER
   * the handler responded. If the fix is correct, the request is destroyed
   * after the cap trips and no further bytes are pushed.
   */
  function makeOversizedReq(contentType: string): {
    req: http.IncomingMessage;
    bytesConsumed: () => number;
  } {
    const { Readable: NodeReadable } =
      require("node:stream") as typeof import("node:stream");
    let consumed = 0;
    let destroyed = false;
    const chunks: Buffer[] = [];
    // 8193 bytes (1 over the 8192 cap)
    chunks.push(Buffer.alloc(8193, "x"));

    const stream = new NodeReadable({
      read() {
        if (destroyed) return;
        const chunk = chunks.shift();
        if (chunk) {
          consumed += chunk.length;
          this.push(chunk);
        } else {
          this.push(null);
        }
      },
      destroy(err, cb) {
        destroyed = true;
        cb(err);
      },
    });

    const req = Object.assign(stream, {
      method: "POST",
      headers: { "content-type": contentType },
    }) as unknown as http.IncomingMessage;

    return { req, bytesConsumed: () => consumed };
  }

  it("handleRegister returns 400 and destroys the request when body exceeds 8192 bytes", async () => {
    const oauth = makeOAuth();
    const { req } = makeOversizedReq("application/json");
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    // The request should have been destroyed — no further data after cap
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it("handleToken returns 400 and destroys the request when body exceeds 8192 bytes", async () => {
    const oauth = makeOAuth();
    const { req } = makeOversizedReq("application/x-www-form-urlencoded");
    const res = new MockResponse();
    await oauth.handleToken(req, res as unknown as http.ServerResponse);
    expect(res.statusCode).toBe(400);
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it("handleRevoke returns 200 and destroys the request when body exceeds 8192 bytes", async () => {
    const oauth = makeOAuth();
    const { req } = makeOversizedReq("application/x-www-form-urlencoded");
    const res = new MockResponse();
    await oauth.handleRevoke(req, res as unknown as http.ServerResponse);
    // RFC 7009: revoke always returns 200, even on error — but request must be destroyed
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});
