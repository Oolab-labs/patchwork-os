/**
 * OAuth 2.0 Authorization Server for claude-ide-bridge.
 *
 * Implements the MCP OAuth 2.0 profile required for authenticated remote servers:
 *   - RFC 8414  Authorization Server Metadata (/.well-known/oauth-authorization-server)
 *   - RFC 6749  Authorization Code Grant with PKCE (S256, RFC 7636)
 *   - RFC 7009  Token Revocation (/oauth/revoke)
 *
 * Design
 *   All state is in-memory. The bridge's static bearer token is the resource owner
 *   credential: only someone who knows it can open an OAuth flow via the approval page.
 *   Issued access tokens are opaque base64url strings stored in a TTL map.
 *   resolveBearerToken() is called by server.ts to admit OAuth-issued tokens alongside
 *   the static bridge token (backward compat).
 *   Refresh tokens are not issued.
 *
 * Security
 *   PKCE S256 mandatory. Auth codes single-use, 5 min TTL. Access tokens 24 h TTL.
 *   All string comparisons via crypto.timingSafeEqual. HTML output attribute-escaped.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { timingSafeStringEqual } from "./crypto.js";

// ── Public interface (consumed by server.ts) ──────────────────────────────────

export interface OAuthServer {
  handleDiscovery(res: ServerResponse): void;
  handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleToken(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void>;
  resolveBearerToken(token: string): string | null;
  /** Resolve the scope string for an OAuth bearer token, or null if invalid/expired. */
  resolveBearerScope(token: string): string | null;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
  used: boolean;
}

interface AccessToken {
  clientId: string;
  scope: string;
  expiresAt: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CODE_TTL_MS = 5 * 60 * 1_000; // 5 min
const TOKEN_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days — GC registered clients after a week
const DEFAULT_SCOPE = "mcp";
const SUPPORTED_SCOPES = ["mcp"];

// ── OAuthServerImpl ───────────────────────────────────────────────────────────

export class OAuthServerImpl implements OAuthServer {
  private readonly bridgeToken: string;
  private readonly issuerUrl: string;
  private readonly authCodes = new Map<string, AuthCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  /** client_id → { redirectUris, issuedAt } (populated by handleRegister) */
  private readonly registeredClients = new Map<
    string,
    { redirectUris: string[]; issuedAt: number }
  >();
  /** Per-IP registration rate limit: IP → { count, windowStart } */
  private readonly registerIpCounts = new Map<
    string,
    { count: number; windowStart: number }
  >();
  private static readonly REGISTER_IP_MAX = 10; // max registrations per IP per minute
  private static readonly REGISTER_IP_WINDOW_MS = 60 * 1_000;
  private readonly gcTimer: ReturnType<typeof setInterval>;
  /** CSRF nonces: client_id → { nonce, expiresAt } */
  private readonly csrfNonces = new Map<
    string,
    { nonce: string; expiresAt: number }
  >();
  private static readonly CSRF_TTL_MS = 10 * 60 * 1_000; // 10 minutes

  constructor(bridgeToken: string, issuerUrl: string) {
    this.bridgeToken = bridgeToken;
    this.issuerUrl = issuerUrl.replace(/\/$/, "");
    this.gcTimer = setInterval(
      () => {
        const now = Date.now();
        for (const [k, v] of this.authCodes)
          if (v.expiresAt < now) this.authCodes.delete(k);
        for (const [k, v] of this.accessTokens)
          if (v.expiresAt < now) this.accessTokens.delete(k);
        for (const [k, v] of this.registeredClients)
          if (now - v.issuedAt > CLIENT_TTL_MS)
            this.registeredClients.delete(k);
        for (const [k, v] of this.csrfNonces)
          if (v.expiresAt < now) this.csrfNonces.delete(k);
        for (const [k, v] of this.registerIpCounts)
          if (now - v.windowStart > OAuthServerImpl.REGISTER_IP_WINDOW_MS)
            this.registerIpCounts.delete(k);
      },
      10 * 60 * 1_000,
    );
    this.gcTimer.unref();
  }

  destroy(): void {
    clearInterval(this.gcTimer);
  }

  // ── RFC 8414 discovery ────────────────────────────────────────────────────

  handleDiscovery(res: ServerResponse): void {
    this.sendJson(res, 200, {
      issuer: this.issuerUrl,
      authorization_endpoint: `${this.issuerUrl}/oauth/authorize`,
      token_endpoint: `${this.issuerUrl}/oauth/token`,
      revocation_endpoint: `${this.issuerUrl}/oauth/revoke`,
      registration_endpoint: `${this.issuerUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SUPPORTED_SCOPES,
    });
  }

  // ── RFC 7591 Dynamic Client Registration ──────────────────────────────────

  async handleRegister(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (c: Buffer) => {
          data += c.toString();
          if (data.length > 8192) reject(new Error("too large"));
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      this.sendJson(res, 400, { error: "invalid_client_metadata" });
      return;
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      this.sendJson(res, 400, { error: "invalid_redirect_uri" });
      return;
    }
    // Validate each redirect_uri is a well-formed absolute HTTPS (or localhost) URL
    for (const uri of redirectUris as unknown[]) {
      if (typeof uri !== "string") {
        this.sendJson(res, 400, { error: "invalid_redirect_uri" });
        return;
      }
      try {
        const u = new URL(uri);
        const isLocalhost =
          u.hostname === "localhost" || u.hostname === "127.0.0.1";
        if (!isLocalhost && u.protocol !== "https:") {
          this.sendJson(res, 400, { error: "invalid_redirect_uri" });
          return;
        }
      } catch {
        this.sendJson(res, 400, { error: "invalid_redirect_uri" });
        return;
      }
    }

    // Validate scope if provided
    if (body.scope !== undefined) {
      const requestedScopes = String(body.scope).split(" ");
      for (const s of requestedScopes) {
        if (!SUPPORTED_SCOPES.includes(s)) {
          this.sendJson(res, 400, {
            error: "invalid_client_metadata",
            error_description: `unsupported scope: ${s}`,
          });
          return;
        }
      }
    }

    // Per-IP rate limit: max 10 registrations per minute per IP
    const remoteIp = (req.socket?.remoteAddress ?? "unknown").slice(0, 64);
    const now = Date.now();
    const ipEntry = this.registerIpCounts.get(remoteIp);
    if (
      ipEntry &&
      now - ipEntry.windowStart < OAuthServerImpl.REGISTER_IP_WINDOW_MS
    ) {
      ipEntry.count++;
      if (ipEntry.count > OAuthServerImpl.REGISTER_IP_MAX) {
        this.sendJson(res, 429, {
          error: "too_many_requests",
          error_description: "per-IP client registration limit reached",
        });
        return;
      }
    } else {
      this.registerIpCounts.set(remoteIp, { count: 1, windowStart: now });
    }

    // Cap registered clients to prevent memory exhaustion via pre-auth DoS.
    // /oauth/register requires no bearer token, so any caller can POST freely.
    if (this.registeredClients.size >= 500) {
      this.sendJson(res, 429, {
        error: "too_many_requests",
        error_description: "client registration limit reached",
      });
      return;
    }

    // Public clients only — no client secret issued
    const clientId = this.randomToken(16);
    this.registeredClients.set(clientId, {
      redirectUris: redirectUris as string[],
      issuedAt: Date.now(),
    });
    this.sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(body.client_name ? { client_name: body.client_name } : {}),
    });
  }

  // ── Authorization endpoint ────────────────────────────────────────────────

  async handleAuthorize(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET") {
      this.authorizeGet(req, res);
    } else if (method === "POST") {
      await this.authorizePost(req, res);
    } else {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, POST" });
      res.end("Method Not Allowed");
    }
  }

  private authorizeGet(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", this.issuerUrl);

    const { error, clientId, redirectUri, codeChallenge, scope, state } =
      this.parseAuthorizeParams(url);

    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(error);
      return;
    }

    // Generate CSRF nonce, keyed by client_id (one nonce per client per auth flow)
    const csrfNonce = crypto.randomBytes(16).toString("hex");
    this.csrfNonces.set(clientId as string, {
      nonce: csrfNonce,
      expiresAt: Date.now() + OAuthServerImpl.CSRF_TTL_MS,
    });

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    res.end(
      this.approvalPage({
        clientId: clientId as string,
        redirectUri: redirectUri as string,
        codeChallenge: codeChallenge as string,
        scope: scope ?? DEFAULT_SCOPE,
        state: state ?? "",
        csrfNonce,
      }),
    );
  }

  private async authorizePost(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const action = body.get("action");
    const clientId = body.get("client_id") ?? "";
    const redirectUri = body.get("redirect_uri") ?? "";
    const codeChallenge = body.get("code_challenge") ?? "";
    const scope = body.get("scope") ?? DEFAULT_SCOPE;
    const state = body.get("state") ?? "";

    const csrfNonce = body.get("csrf_nonce") ?? "";

    if (!clientId || !redirectUri || !codeChallenge) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("missing parameters");
      return;
    }

    // Verify CSRF nonce before any further processing
    const storedCsrf = this.csrfNonces.get(clientId);
    if (
      !storedCsrf ||
      storedCsrf.expiresAt < Date.now() ||
      !timingSafeStringEqual(csrfNonce, storedCsrf.nonce)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("invalid or expired CSRF token");
      return;
    }
    // Consume the nonce (one-time use)
    this.csrfNonces.delete(clientId);

    // Validate redirect_uri against registered URIs to prevent open redirect
    const registered = this.registeredClients.get(clientId);
    if (!registered?.redirectUris.includes(redirectUri)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("invalid redirect_uri");
      return;
    }

    if (action === "deny") {
      const u = new URL(redirectUri);
      u.searchParams.set("error", "access_denied");
      if (state) u.searchParams.set("state", state);
      res.writeHead(302, { Location: u.toString() });
      res.end();
      return;
    }

    if (action !== "approve") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("invalid action");
      return;
    }

    // Verify bridge token on approve
    const presentedToken = body.get("bridge_token") ?? "";
    if (!timingSafeStringEqual(presentedToken, this.bridgeToken)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        this.approvalPage({
          clientId,
          redirectUri,
          codeChallenge,
          scope,
          state,
          tokenError: true,
        }),
      );
      return;
    }

    const code = this.randomToken(32);
    this.authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      scope,
      expiresAt: Date.now() + CODE_TTL_MS,
      used: false,
    });

    const dest = new URL(redirectUri);
    dest.searchParams.set("code", code);
    if (state) dest.searchParams.set("state", state);
    res.writeHead(302, { Location: dest.toString() });
    res.end();
  }

  // ── Token endpoint ────────────────────────────────────────────────────────

  async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);

    if (body.get("grant_type") !== "authorization_code") {
      this.sendError(res, 400, "unsupported_grant_type");
      return;
    }

    const code = body.get("code") ?? "";
    const redirectUri = body.get("redirect_uri") ?? "";
    const clientId = body.get("client_id") ?? "";
    const verifier = body.get("code_verifier") ?? "";

    if (!code || !redirectUri || !clientId || !verifier) {
      this.sendError(
        res,
        400,
        "invalid_request",
        "missing required parameters",
      );
      return;
    }

    const record = this.authCodes.get(code);
    if (!record) {
      this.sendError(
        res,
        400,
        "invalid_grant",
        "authorization code not found or expired",
      );
      return;
    }
    if (record.used) {
      this.sendError(
        res,
        400,
        "invalid_grant",
        "authorization code already used",
      );
      return;
    }
    if (record.expiresAt < Date.now()) {
      this.authCodes.delete(code);
      this.sendError(res, 400, "invalid_grant", "authorization code expired");
      return;
    }
    if (!timingSafeStringEqual(record.clientId, clientId)) {
      this.sendError(res, 400, "invalid_grant", "client_id mismatch");
      return;
    }
    if (!timingSafeStringEqual(record.redirectUri, redirectUri)) {
      this.sendError(res, 400, "invalid_grant", "redirect_uri mismatch");
      return;
    }
    if (!this.pkceVerify(verifier, record.codeChallenge)) {
      this.sendError(res, 400, "invalid_grant", "code_verifier mismatch");
      return;
    }

    record.used = true;

    const accessToken = this.randomToken(32);
    this.accessTokens.set(accessToken, {
      clientId,
      scope: record.scope,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    this.sendJson(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1_000),
      scope: record.scope,
    });
  }

  // ── Revocation endpoint (RFC 7009) ────────────────────────────────────────

  async handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const token = body.get("token");
      if (token) {
        this.accessTokens.delete(token);
        this.authCodes.delete(token);
      }
    } catch {
      // RFC 7009: always 200
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end("{}");
  }

  // ── Bearer resolution (called by server.ts) ───────────────────────────────

  resolveBearerToken(token: string): string | null {
    const record = this.accessTokens.get(token);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      return null;
    }
    return this.bridgeToken;
  }

  resolveBearerScope(token: string): string | null {
    const record = this.accessTokens.get(token);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      return null;
    }
    return record.scope;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private randomToken(bytes: number): string {
    return crypto.randomBytes(bytes).toString("base64url");
  }

  private pkceVerify(verifier: string, challenge: string): boolean {
    const hash = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    return timingSafeStringEqual(hash, challenge);
  }

  private readBody(req: IncomingMessage): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 8_192) reject(new Error("Request body too large"));
      });
      req.on("end", () => resolve(new URLSearchParams(data)));
      req.on("error", reject);
    });
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
    res.end(JSON.stringify(body));
  }

  private sendError(
    res: ServerResponse,
    status: number,
    error: string,
    description?: string,
  ): void {
    this.sendJson(res, status, {
      error,
      ...(description ? { error_description: description } : {}),
    });
  }

  private parseAuthorizeParams(url: URL): {
    error?: string;
    clientId?: string;
    redirectUri?: string;
    codeChallenge?: string;
    scope?: string;
    state?: string;
  } {
    const responseType = url.searchParams.get("response_type");
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state");

    if (responseType !== "code") return { error: "unsupported_response_type" };
    if (!clientId || !redirectUri || !codeChallenge)
      return { error: "invalid_request" };
    if (codeChallengeMethod !== "S256") return { error: "invalid_request" };

    // Validate redirect_uri against registered URIs to prevent open redirect
    const registered = this.registeredClients.get(clientId);
    if (!registered?.redirectUris.includes(redirectUri)) {
      return { error: "invalid_redirect_uri" };
    }

    return {
      clientId,
      redirectUri,
      codeChallenge,
      scope: url.searchParams.get("scope") ?? DEFAULT_SCOPE,
      state: state ?? "",
    };
  }

  // ── Approval page HTML ────────────────────────────────────────────────────

  private approvalPage(opts: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    state: string;
    tokenError?: boolean;
    csrfNonce?: string;
  }): string {
    const e = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize \u2014 Claude IDE Bridge</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#0f1117;color:#e2e8f0;display:flex;align-items:center;
         justify-content:center;min-height:100vh;padding:2rem}
    .card{background:#1a1d27;border:1px solid #2d3148;border-radius:12px;
          padding:2rem;max-width:420px;width:100%;box-shadow:0 4px 32px rgba(0,0,0,.4)}
    .logo{font-size:1.5rem;font-weight:700;color:#818cf8;margin-bottom:1.5rem}
    h1{font-size:1.1rem;margin-bottom:.5rem}
    .client{font-size:.9rem;color:#94a3b8;margin-bottom:1.5rem;word-break:break-all}
    .scope{background:#12141e;border:1px solid #2d3148;border-radius:8px;
           padding:1rem;margin-bottom:1.5rem;font-size:.875rem;color:#94a3b8}
    .scope strong{color:#e2e8f0;display:block;margin-bottom:.5rem}
    .item::before{content:"\u2713 ";color:#34d399}
    .token-field{margin-bottom:1.25rem}
    .token-field label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.4rem}
    .token-field input{width:100%;padding:.5rem .75rem;background:#12141e;border:1px solid #2d3148;
           border-radius:6px;color:#e2e8f0;font-size:.875rem;font-family:monospace}
    .token-field input.err{border-color:#f87171}
    .token-err{color:#f87171;font-size:.8rem;margin-top:.3rem}
    .actions{display:flex;gap:.75rem}
    button{flex:1;padding:.65rem 1rem;border:none;border-radius:8px;
           font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s}
    button:hover{opacity:.85}
    .approve{background:#818cf8;color:#0f1117}
    .deny{background:#2d3148;color:#94a3b8}
    footer{margin-top:1.25rem;font-size:.75rem;color:#475569;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">\u29ed Claude IDE Bridge</div>
    <h1>Authorization Request</h1>
    <p class="client">Client: <strong>${e(opts.clientId)}</strong></p>
    <div class="scope">
      <strong>Requested permissions</strong>
      <div class="item">Full MCP tool access (read, write, execute)</div>
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id"      value="${e(opts.clientId)}">
      <input type="hidden" name="redirect_uri"   value="${e(opts.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${e(opts.codeChallenge)}">
      <input type="hidden" name="scope"          value="${e(opts.scope)}">
      <input type="hidden" name="state"          value="${e(opts.state)}">
      <input type="hidden" name="csrf_nonce"     value="${e(opts.csrfNonce ?? "")}">
      <div class="token-field">
        <label for="bridge_token">Bridge Token</label>
        <input id="bridge_token" type="password" name="bridge_token" placeholder="Paste your bridge token"
               class="${opts.tokenError ? "err" : ""}" autocomplete="off" required>
        ${opts.tokenError ? '<div class="token-err">Incorrect token — check your bridge token and try again.</div>' : ""}
      </div>
      <div class="actions">
        <button class="approve" type="submit" name="action" value="approve">Authorize</button>
        <button class="deny"    type="submit" name="action" value="deny">Deny</button>
      </div>
    </form>
    <footer>
      Issuer: ${e(this.issuerUrl)}<br>
      Only approve if you initiated this from your MCP client.
    </footer>
  </div>
</body>
</html>`;
  }
}
