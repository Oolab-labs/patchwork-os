import crypto from "node:crypto";
import http from "node:http";
import { parse as parseQs } from "node:querystring";

/**
 * OAuth 2.1 Authorization Server + Resource Server for claude-ide-bridge.
 *
 * Implements the MCP spec (2025-11-25) authorization requirements:
 *  - /.well-known/oauth-protected-resource  (RFC 9728)
 *  - /.well-known/oauth-authorization-server (RFC 8414)
 *  - GET  /authorize  — approval page
 *  - POST /authorize  — form submit (issues auth code)
 *  - POST /token      — code + PKCE verifier → access token
 *
 * The existing authToken from the lock file is issued as the access token —
 * no new token system is needed.
 */

// Redirect URIs accepted from MCP clients (Claude Code / Claude Desktop).
export const ALLOWED_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost:6274/oauth/callback",
  "http://localhost:6274/oauth/callback/debug",
]);

// Max concurrent in-flight auth codes (anti-stuffing).
const MAX_PENDING_CODES = 20;
// Auth code TTL in milliseconds.
const CODE_TTL_MS = 60_000;
// Prune interval for expired codes.
const PRUNE_INTERVAL_MS = 5 * 60_000;

interface PendingCode {
  challenge: string; // S256 code_challenge value
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function verifyS256(verifier: string, storedChallenge: string): boolean {
  // RFC 7636: verifier charset [A-Z a-z 0-9 - . _ ~], length 43-128
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  if (digest.length !== storedChallenge.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(storedChallenge),
  );
}

function buildApprovalPage(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  port: number;
}): string {
  const { clientId, redirectUri, codeChallenge, state, port } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize — Claude IDE Bridge</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px;
           margin: 80px auto; padding: 0 1rem; color: #1a1a1a; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-top: 0; }
    p  { font-size: .9rem; color: #444; }
    .client { font-weight: 600; }
    .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
    button { flex: 1; padding: .6rem; border-radius: 6px;
             font-size: .95rem; cursor: pointer; border: 1px solid; }
    .allow  { background: #1a56db; color: #fff; border-color: #1a56db; }
    .deny   { background: #fff; color: #111; border-color: #ccc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p>
      <span class="client">${escapeHtml(clientId)}</span> wants to connect
      to your local Claude IDE Bridge on port ${port}.
    </p>
    <p>This will grant access to your IDE tools, file system, and terminal.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="response_type"         value="code">
      <input type="hidden" name="client_id"             value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri"          value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="code_challenge"        value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="S256">
      <input type="hidden" name="state"                 value="${escapeHtml(state)}">
      <div class="actions">
        <button class="allow" type="submit" name="approve" value="true">Allow</button>
        <button class="deny"  type="submit" name="approve" value="false">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function oauthError(
  res: http.ServerResponse,
  status: number,
  error: string,
  description?: string,
): void {
  sendJson(res, status, {
    error,
    ...(description ? { error_description: description } : {}),
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (chunks.reduce((n, b) => n + b.length, 0) + c.length > 65_536) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export class OAuthServer {
  private port = 0;
  private bindAddress = "127.0.0.1";
  private codes = new Map<string, PendingCode>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly authToken: string) {
    this.pruneTimer = setInterval(() => this.pruneExpiredCodes(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  setPort(port: number, bindAddress = "127.0.0.1"): void {
    this.port = port;
    this.bindAddress = bindAddress;
  }

  close(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private baseUrl(): string {
    const host =
      this.bindAddress === "0.0.0.0" || this.bindAddress === "::"
        ? "localhost"
        : this.bindAddress;
    return `http://${host}:${this.port}`;
  }

  private pruneExpiredCodes(): void {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < now) this.codes.delete(code);
    }
  }

  /** WWW-Authenticate header value to include on 401 responses. */
  wwwAuthenticate(): string {
    const base = this.baseUrl();
    return `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
  }

  // ──────────────────────────────────────────────────────────
  // GET /.well-known/oauth-protected-resource (RFC 9728)
  // ──────────────────────────────────────────────────────────
  handleProtectedResourceMetadata(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const base = this.baseUrl();
    sendJson(res, 200, {
      resource: base,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "https://github.com/Oolab-labs/claude-ide-bridge",
    });
  }

  // ──────────────────────────────────────────────────────────
  // GET /.well-known/oauth-authorization-server (RFC 8414)
  // ──────────────────────────────────────────────────────────
  handleAuthorizationServerMetadata(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const base = this.baseUrl();
    sendJson(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }

  // ──────────────────────────────────────────────────────────
  // GET /authorize — show approval page
  // POST /authorize — process approval form
  // ──────────────────────────────────────────────────────────
  async handleAuthorize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method === "GET") {
      return this.handleAuthorizeGet(req, res);
    }
    if (req.method === "POST") {
      return this.handleAuthorizePost(req, res);
    }
    res.writeHead(405, { Allow: "GET, POST" });
    res.end("Method Not Allowed");
  }

  private handleAuthorizeGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.searchParams;

    const err = this.validateAuthorizeParams(
      p.get("response_type"),
      p.get("redirect_uri"),
      p.get("code_challenge"),
      p.get("code_challenge_method"),
    );
    if (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Bad Request: ${err}`);
      return;
    }

    const html = buildApprovalPage({
      clientId: p.get("client_id") ?? "(unknown)",
      redirectUri: p.get("redirect_uri") ?? "",
      codeChallenge: p.get("code_challenge") ?? "",
      state: p.get("state") ?? "",
      port: this.port,
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private async handleAuthorizePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: could not read body");
      return;
    }

    const p = parseQs(body) as Record<string, string>;
    const redirectUri = p.redirect_uri ?? "";
    const state = p.state ?? "";

    const err = this.validateAuthorizeParams(
      p.response_type ?? null,
      redirectUri,
      p.code_challenge ?? null,
      p.code_challenge_method ?? null,
    );
    if (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Bad Request: ${err}`);
      return;
    }

    if (p.approve !== "true") {
      const dest = new URL(redirectUri);
      dest.searchParams.set("error", "access_denied");
      if (state) dest.searchParams.set("state", state);
      res.writeHead(302, { Location: dest.toString() });
      res.end();
      return;
    }

    if (this.codes.size >= MAX_PENDING_CODES) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Service Unavailable: too many pending authorizations");
      return;
    }

    const code = crypto.randomBytes(32).toString("hex");
    this.codes.set(code, {
      challenge: p.code_challenge ?? "",
      redirectUri,
      clientId: p.client_id ?? "",
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const dest = new URL(redirectUri);
    dest.searchParams.set("code", code);
    if (state) dest.searchParams.set("state", state);
    res.writeHead(302, { Location: dest.toString() });
    res.end();
  }

  private validateAuthorizeParams(
    responseType: string | null,
    redirectUri: string | null,
    codeChallenge: string | null,
    codeChallengeMethod: string | null,
  ): string | null {
    if (responseType !== "code") return "response_type must be 'code'";
    if (!redirectUri || !ALLOWED_REDIRECT_URIS.has(redirectUri))
      return "redirect_uri not in allowlist";
    if (codeChallengeMethod !== "S256")
      return "code_challenge_method must be 'S256'";
    if (!codeChallenge || !/^[A-Za-z0-9\-._~]{43,128}$/.test(codeChallenge))
      return "code_challenge missing or invalid";
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // POST /token — exchange auth code + PKCE for access token
  // ──────────────────────────────────────────────────────────
  async handleToken(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      oauthError(res, 400, "invalid_request", "Could not read request body");
      return;
    }

    const p = parseQs(body) as Record<string, string>;

    if (p.grant_type !== "authorization_code") {
      oauthError(res, 400, "unsupported_grant_type");
      return;
    }

    const code = p.code ?? "";
    const verifier = p.code_verifier ?? "";
    const redirectUri = p.redirect_uri ?? "";

    const entry = this.codes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      this.codes.delete(code);
      oauthError(res, 400, "invalid_grant", "Auth code expired or already used");
      return;
    }

    if (entry.redirectUri !== redirectUri) {
      oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
      return;
    }

    if (!verifyS256(verifier, entry.challenge)) {
      oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }

    // Consume the code — single-use only.
    this.codes.delete(code);

    sendJson(res, 200, {
      access_token: this.authToken,
      token_type: "Bearer",
      expires_in: 0,
      scope: "mcp",
    });
  }
}

export function createOAuthServer(authToken: string): OAuthServer {
  return new OAuthServer(authToken);
}
