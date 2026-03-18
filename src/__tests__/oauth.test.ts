import crypto from "node:crypto";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_REDIRECT_URIS, OAuthServer } from "../oauth.js";

const TEST_TOKEN = crypto.randomBytes(32).toString("hex");
const REDIRECT_URI = "http://localhost:6274/oauth/callback";

function makeCodeVerifier(): string {
  // 43-char URL-safe string (minimum valid length)
  return crypto.randomBytes(32).toString("base64url").slice(0, 43);
}

function makeCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body = "";
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(k: string, v: string) { headers[k] = v; },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end(data?: string) { body = data ?? ""; },
  } as unknown as http.ServerResponse & { headers: Record<string, string>; statusCode: number; body: string };
}

function mockReq(method: string, url: string, body?: string): http.IncomingMessage {
  const { Readable } = require("node:stream");
  const chunks = body ? [Buffer.from(body, "utf-8")] : [];
  const req = Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: {} as Record<string, string>,
  }) as unknown as http.IncomingMessage;
  return req;
}

describe("OAuthServer", () => {
  let server: OAuthServer;

  beforeEach(() => {
    server = new OAuthServer(TEST_TOKEN);
    server.setPort(3000);
  });

  afterEach(() => {
    server.close();
  });

  // ── ALLOWED_REDIRECT_URIS ──────────────────────────────────
  it("includes all four required Claude callback URIs", () => {
    expect(ALLOWED_REDIRECT_URIS.has("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(ALLOWED_REDIRECT_URIS.has("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(ALLOWED_REDIRECT_URIS.has("http://localhost:6274/oauth/callback")).toBe(true);
    expect(ALLOWED_REDIRECT_URIS.has("http://localhost:6274/oauth/callback/debug")).toBe(true);
  });

  // ── /.well-known/oauth-protected-resource ─────────────────
  describe("handleProtectedResourceMetadata", () => {
    it("returns 200 with correct fields", () => {
      const res = mockRes();
      server.handleProtectedResourceMetadata(mockReq("GET", "/.well-known/oauth-protected-resource"), res);
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.resource).toBe("http://127.0.0.1:3000");
      expect(data.authorization_servers).toContain("http://127.0.0.1:3000");
      expect(data.bearer_methods_supported).toContain("header");
    });

    it("includes CORS header", () => {
      const res = mockRes();
      server.handleProtectedResourceMetadata(mockReq("GET", "/"), res);
      expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    });
  });

  // ── /.well-known/oauth-authorization-server ───────────────
  describe("handleAuthorizationServerMetadata", () => {
    it("returns S256 in code_challenge_methods_supported", () => {
      const res = mockRes();
      server.handleAuthorizationServerMetadata(mockReq("GET", "/"), res);
      const data = JSON.parse(res.body);
      expect(data.code_challenge_methods_supported).toContain("S256");
    });

    it("points endpoints to correct base URL", () => {
      const res = mockRes();
      server.handleAuthorizationServerMetadata(mockReq("GET", "/"), res);
      const data = JSON.parse(res.body);
      expect(data.authorization_endpoint).toBe("http://127.0.0.1:3000/authorize");
      expect(data.token_endpoint).toBe("http://127.0.0.1:3000/token");
      expect(data.issuer).toBe("http://127.0.0.1:3000");
    });
  });

  // ── GET /authorize ────────────────────────────────────────
  describe("GET /authorize", () => {
    it("returns HTML approval page for valid params", async () => {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const res = mockRes();
      await server.handleAuthorize(
        mockReq("GET", `/authorize?response_type=code&client_id=claude&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<form");
      expect(res.body).toContain('name="approve"');
    });

    it("rejects unknown redirect_uri", async () => {
      const challenge = makeCodeChallenge(makeCodeVerifier());
      const res = mockRes();
      await server.handleAuthorize(
        mockReq("GET", `/authorize?response_type=code&client_id=x&redirect_uri=https://evil.com&code_challenge=${challenge}&code_challenge_method=S256`),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing code_challenge", async () => {
      const res = mockRes();
      await server.handleAuthorize(
        mockReq("GET", `/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge_method=S256`),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it("rejects plain code_challenge_method", async () => {
      const challenge = makeCodeChallenge(makeCodeVerifier());
      const res = mockRes();
      await server.handleAuthorize(
        mockReq("GET", `/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=plain`),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it("rejects wrong response_type", async () => {
      const challenge = makeCodeChallenge(makeCodeVerifier());
      const res = mockRes();
      await server.handleAuthorize(
        mockReq("GET", `/authorize?response_type=token&client_id=x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`),
        res,
      );
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /authorize ───────────────────────────────────────
  describe("POST /authorize — form submission", () => {
    function buildFormBody(overrides: Record<string, string> = {}): string {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const params: Record<string, string> = {
        response_type: "code",
        client_id: "claude",
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "xyz",
        approve: "true",
        ...overrides,
      };
      return new URLSearchParams(params).toString();
    }

    it("issues auth code and redirects on approve=true", async () => {
      const body = buildFormBody();
      const res = mockRes();
      await server.handleAuthorize(mockReq("POST", "/authorize", body), res);
      expect(res.statusCode).toBe(302);
      const loc = res.headers["Location"];
      expect(loc).toContain("code=");
      expect(loc).toContain("state=xyz");
    });

    it("redirects with error=access_denied on approve=false", async () => {
      const body = buildFormBody({ approve: "false" });
      const res = mockRes();
      await server.handleAuthorize(mockReq("POST", "/authorize", body), res);
      expect(res.statusCode).toBe(302);
      expect(res.headers["Location"]).toContain("error=access_denied");
    });

    it("does not include state when state is empty", async () => {
      const body = buildFormBody({ state: "" });
      const res = mockRes();
      await server.handleAuthorize(mockReq("POST", "/authorize", body), res);
      expect(res.statusCode).toBe(302);
      expect(res.headers["Location"]).not.toContain("state=");
    });
  });

  // ── POST /token ───────────────────────────────────────────
  describe("POST /token", () => {
    async function issueCode(challenge: string): Promise<string> {
      const body = new URLSearchParams({
        response_type: "code",
        client_id: "claude",
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "",
        approve: "true",
      }).toString();
      const res = mockRes();
      await server.handleAuthorize(mockReq("POST", "/authorize", body), res);
      const loc = res.headers["Location"];
      return new URL(loc).searchParams.get("code") ?? "";
    }

    it("exchanges valid code+verifier for the auth token", async () => {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const code = await issueCode(challenge);

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString();

      const res = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res);
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.access_token).toBe(TEST_TOKEN);
      expect(data.token_type).toBe("Bearer");
    });

    it("rejects wrong code_verifier", async () => {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const code = await issueCode(challenge);

      const wrongVerifier = makeCodeVerifier(); // different verifier
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: wrongVerifier,
      }).toString();

      const res = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_grant");
    });

    it("rejects code reuse (single-use enforcement)", async () => {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const code = await issueCode(challenge);
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString();

      // First use — should succeed
      const res1 = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res1);
      expect(res1.statusCode).toBe(200);

      // Second use — should fail
      const res2 = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res2);
      expect(res2.statusCode).toBe(400);
      expect(JSON.parse(res2.body).error).toBe("invalid_grant");
    });

    it("rejects expired code", async () => {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const code = await issueCode(challenge);

      // Manually expire the code
      const entry = (server as unknown as { codes: Map<string, { expiresAt: number }> }).codes.get(code);
      if (entry) entry.expiresAt = Date.now() - 1;

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString();

      const res = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_grant");
    });

    it("rejects redirect_uri mismatch", async () => {
      const verifier = makeCodeVerifier();
      const challenge = makeCodeChallenge(verifier);
      const code = await issueCode(challenge);

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:6274/oauth/callback/debug", // different URI
        code_verifier: verifier,
      }).toString();

      const res = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid_grant");
    });

    it("rejects unsupported grant_type", async () => {
      const tokenBody = new URLSearchParams({
        grant_type: "client_credentials",
      }).toString();
      const res = mockRes();
      await server.handleToken(mockReq("POST", "/token", tokenBody), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
    });
  });

  // ── WWW-Authenticate ──────────────────────────────────────
  describe("wwwAuthenticate", () => {
    it("includes resource_metadata pointing to /.well-known/oauth-protected-resource", () => {
      const header = server.wwwAuthenticate();
      expect(header).toContain("Bearer");
      expect(header).toContain("resource_metadata=");
      expect(header).toContain("/.well-known/oauth-protected-resource");
    });
  });

  // ── HTML escaping ─────────────────────────────────────────
  describe("approval page HTML escaping", () => {
    it("escapes client_id to prevent XSS", async () => {
      const challenge = makeCodeChallenge(makeCodeVerifier());
      const res = mockRes();
      await server.handleAuthorize(
        mockReq(
          "GET",
          `/authorize?response_type=code&client_id=%3Cscript%3Ealert(1)%3C%2Fscript%3E&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`,
        ),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("<script>");
      expect(res.body).toContain("&lt;script&gt;");
    });
  });
});
