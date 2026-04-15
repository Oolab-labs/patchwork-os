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
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
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

// ── CIMD SSRF guard ───────────────────────────────────────────────────────────

/**
 * Blocks private/loopback hostnames for CIMD fetches.
 * CIMD URLs must be public HTTPS — rejecting private addresses prevents
 * SSRF via a crafted client_id URL.
 */
function isPrivateCimdHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|]$/g, ""); // strip IPv6 brackets
  if (
    h === "localhost" ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("169.254.")
  )
    return true;
  // 172.16.0.0/12
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
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
  /** CSRF nonces: flowId → { nonce, clientId, expiresAt } */
  private readonly csrfNonces = new Map<
    string,
    { nonce: string; clientId: string; expiresAt: number }
  >();
  private static readonly CSRF_TTL_MS = 10 * 60 * 1_000; // 10 minutes
  /**
   * CIMD cache: client_id URL → { redirectUris, fetchedAt }
   * Short TTL (5 min) — avoids re-fetching on every authorize request while
   * staying fresh enough for clients that rotate their metadata.
   */
  private readonly cimdCache = new Map<
    string,
    { redirectUris: string[]; fetchedAt: number }
  >();
  private static readonly CIMD_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 min
  private static readonly CIMD_MAX_BYTES = 8_192; // 8 KB max for metadata doc

  /** Path to the persisted token file; null when persistence is disabled. */
  private readonly tokenStorePath: string | null;
  private readonly tokenTtlMs: number;
  /**
   * Tokens loaded from disk on startup: SHA-256(token) → AccessToken.
   * In-memory issued tokens use `accessTokens` (raw key). Both are checked
   * in resolveBearerToken — disk tokens are promoted to accessTokens on first use.
   */
  private readonly hashedTokens = new Map<string, AccessToken>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    bridgeToken: string,
    issuerUrl: string,
    opts?: { configDir?: string; tokenTtlMs?: number },
  ) {
    this.bridgeToken = bridgeToken;
    this.issuerUrl = issuerUrl.replace(/\/$/, "");
    this.tokenTtlMs = opts?.tokenTtlMs ?? TOKEN_TTL_MS;
    this.tokenStorePath = opts?.configDir
      ? path.join(opts.configDir, "ide", "oauth-tokens.json")
      : null;
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
        for (const [k, v] of this.cimdCache)
          if (now - v.fetchedAt > OAuthServerImpl.CIMD_CACHE_TTL_MS)
            this.cimdCache.delete(k);
      },
      10 * 60 * 1_000,
    );
    this.gcTimer.unref();
    this.loadTokens();
  }

  destroy(): void {
    // Flush any pending debounced persist before shutdown
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistTokens();
    }
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
        const onData = (c: Buffer) => {
          data += c.toString();
          if (data.length > 8192) {
            req.removeListener("data", onData);
            req.removeListener("end", onEnd);
            req.destroy();
            reject(new Error("too large"));
          }
        };
        const onEnd = () => resolve(data);
        req.on("data", onData);
        req.on("end", onEnd);
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
      ...(body.client_name
        ? {
            client_name:
              typeof body.client_name === "string"
                ? body.client_name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128)
                : undefined,
          }
        : {}),
    });
  }

  // ── Authorization endpoint ────────────────────────────────────────────────

  async handleAuthorize(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET") {
      await this.authorizeGet(req, res);
    } else if (method === "POST") {
      await this.authorizePost(req, res);
    } else {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, POST" });
      res.end("Method Not Allowed");
    }
  }

  private async authorizeGet(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.issuerUrl);

    const { error, clientId, redirectUri, codeChallenge, scope, state } =
      await this.parseAuthorizeParams(url);

    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(error);
      return;
    }

    // Generate CSRF nonce keyed by a random flowId (not client_id) so concurrent
    // authorization flows for the same client_id cannot overwrite each other's nonce.
    const csrfNonce = crypto.randomBytes(16).toString("hex");
    const flowId = crypto.randomBytes(8).toString("hex");
    this.csrfNonces.set(flowId, {
      nonce: csrfNonce,
      clientId: clientId as string,
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
        flowId,
      }),
    );
  }

  private async authorizePost(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: URLSearchParams;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("request body too large");
      return;
    }
    const action = body.get("action");
    const clientId = body.get("client_id") ?? "";
    const redirectUri = body.get("redirect_uri") ?? "";
    const codeChallenge = body.get("code_challenge") ?? "";
    const scope = body.get("scope") ?? DEFAULT_SCOPE;
    const state = body.get("state") ?? "";

    const csrfNonce = body.get("csrf_nonce") ?? "";
    const flowId = body.get("flow_id") ?? "";

    if (!clientId || !redirectUri || !codeChallenge) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("missing parameters");
      return;
    }

    // Verify CSRF nonce before any further processing.
    // Look up by flowId (not clientId) to prevent concurrent-flow nonce collision attacks.
    const storedCsrf = this.csrfNonces.get(flowId);
    if (
      !storedCsrf ||
      storedCsrf.expiresAt < Date.now() ||
      storedCsrf.clientId !== clientId ||
      !timingSafeStringEqual(csrfNonce, storedCsrf.nonce)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("invalid or expired CSRF token");
      return;
    }
    // Consume the nonce (one-time use)
    this.csrfNonces.delete(flowId);

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
      // Issue a fresh flowId + nonce for the retry so the form remains usable.
      const retryCsrfNonce = crypto.randomBytes(16).toString("hex");
      const retryFlowId = crypto.randomBytes(8).toString("hex");
      this.csrfNonces.set(retryFlowId, {
        nonce: retryCsrfNonce,
        clientId,
        expiresAt: Date.now() + OAuthServerImpl.CSRF_TTL_MS,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        this.approvalPage({
          clientId,
          redirectUri,
          codeChallenge,
          scope,
          state,
          tokenError: true,
          csrfNonce: retryCsrfNonce,
          flowId: retryFlowId,
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
    let body: URLSearchParams;
    try {
      body = await this.readBody(req);
    } catch {
      this.sendError(res, 400, "invalid_request");
      return;
    }

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

    // RFC 6749 §4.1.2: delete the auth code immediately on use.
    // A missing code naturally rejects replay attempts (the !record check above).
    this.authCodes.delete(code);

    const accessToken = this.randomToken(32);
    this.accessTokens.set(accessToken, {
      clientId,
      scope: record.scope,
      expiresAt: Date.now() + this.tokenTtlMs,
    });
    this.schedulePersist();

    this.sendJson(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.tokenTtlMs / 1_000),
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
        // Also remove from hashed (disk-persisted) tokens
        const hash = this.hashToken(token);
        this.hashedTokens.delete(hash);
        this.schedulePersist();
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
    const record = this.lookupToken(token);
    if (!record) return null;
    return this.bridgeToken;
  }

  resolveBearerScope(token: string): string | null {
    const record = this.lookupToken(token);
    if (!record) return null;
    return record.scope;
  }

  /**
   * Lookup a bearer token in memory first, then fall back to disk-loaded hashed
   * tokens. Promotes disk tokens to the in-memory map on first use for fast
   * subsequent lookups.
   */
  private lookupToken(token: string): AccessToken | null {
    // 1. Check in-memory map (tokens issued this session)
    const inMemory = this.accessTokens.get(token);
    if (inMemory) {
      if (inMemory.expiresAt < Date.now()) {
        this.accessTokens.delete(token);
        return null;
      }
      return inMemory;
    }
    // 2. Check disk-loaded hashed tokens (tokens issued before last restart)
    const hash = this.hashToken(token);
    const fromDisk = this.hashedTokens.get(hash);
    if (fromDisk) {
      if (fromDisk.expiresAt < Date.now()) {
        this.hashedTokens.delete(hash);
        return null;
      }
      // Promote to in-memory for fast subsequent lookups
      this.accessTokens.set(token, fromDisk);
      this.hashedTokens.delete(hash);
      return fromDisk;
    }
    return null;
  }

  // ── Token persistence helpers ─────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private loadTokens(): void {
    if (!this.tokenStorePath) return;
    try {
      const raw = fs.readFileSync(this.tokenStorePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version: number;
        tokens: Record<
          string,
          { clientId: string; scope: string; expiresAt: number }
        >;
      };
      if (parsed.version !== 1 || typeof parsed.tokens !== "object") return;
      const entries = Object.entries(parsed.tokens);
      // Cap: refuse to load a file with suspiciously many entries to prevent DoS
      if (entries.length > 10_000) {
        console.warn(
          "[claude-ide-bridge] oauth-tokens.json contains >10,000 entries — skipping load",
        );
        return;
      }
      const now = Date.now();
      for (const [hash, entry] of entries) {
        // Validate each field before trusting the persisted data
        if (
          typeof entry.clientId !== "string" ||
          typeof entry.scope !== "string" ||
          typeof entry.expiresAt !== "number" ||
          !Number.isFinite(entry.expiresAt) ||
          entry.expiresAt <= 0 ||
          !SUPPORTED_SCOPES.some(
            (s) =>
              entry.scope === s ||
              entry.scope
                .split(" ")
                .every((tok: string) => SUPPORTED_SCOPES.includes(tok)),
          )
        ) {
          continue; // skip invalid entries
        }
        if (entry.expiresAt > now) {
          this.hashedTokens.set(hash, {
            clientId: entry.clientId,
            scope: entry.scope,
            expiresAt: entry.expiresAt,
          });
        }
      }
    } catch {
      // Missing or corrupt file — start fresh
    }
  }

  private persistTokens(): void {
    if (!this.tokenStorePath) return;
    try {
      const now = Date.now();
      const tokens: Record<
        string,
        { clientId: string; scope: string; expiresAt: number }
      > = {};
      // Persist current in-memory tokens (keyed by hash).
      // Invariant: a promoted disk token exists ONLY in `accessTokens` — it was
      // deleted from `hashedTokens` at promotion time. Do not write it from both
      // maps or revocation tracking breaks.
      for (const [rawToken, record] of this.accessTokens) {
        if (record.expiresAt > now) {
          tokens[this.hashToken(rawToken)] = {
            clientId: record.clientId,
            scope: record.scope,
            expiresAt: record.expiresAt,
          };
        }
      }
      // Persist still-valid disk tokens that have not yet been promoted.
      // The `!(hash in tokens)` guard is a safety net — promoted tokens should
      // already be absent from `hashedTokens`, but the check prevents any
      // double-write if that invariant is ever violated.
      for (const [hash, record] of this.hashedTokens) {
        if (record.expiresAt > now && !(hash in tokens)) {
          tokens[hash] = {
            clientId: record.clientId,
            scope: record.scope,
            expiresAt: record.expiresAt,
          };
        }
      }
      const data = JSON.stringify({ version: 1, tokens }, null, 2);
      const tmpPath = `${this.tokenStorePath}.tmp`;
      const dir = path.dirname(this.tokenStorePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, data, { mode: 0o600 });
      fs.renameSync(tmpPath, this.tokenStorePath);
      fs.chmodSync(this.tokenStorePath, 0o600);
    } catch {
      // Best-effort — never block operation
    }
  }

  private schedulePersist(): void {
    if (!this.tokenStorePath) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistTokens();
    }, 500).unref(); // unref so a pending flush doesn't prevent process exit
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
      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 8_192) {
          req.removeListener("data", onData);
          req.removeListener("end", onEnd);
          req.destroy();
          reject(new Error("Request body too large"));
        }
      };
      const onEnd = () => resolve(new URLSearchParams(data));
      req.on("data", onData);
      req.on("end", onEnd);
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

  /**
   * Fetch and cache a Client ID Metadata Document (CIMD / SEP-991).
   * Called when client_id is an HTTPS URL instead of an opaque registered ID.
   * Returns the redirect_uris from the document, or null on any error.
   *
   * Security: only public HTTPS URLs are allowed (isPrivateCimdHost blocks
   * RFC 1918 / loopback). Response size capped at CIMD_MAX_BYTES.
   */
  private async fetchCimd(clientIdUrl: string): Promise<string[] | null> {
    const cached = this.cimdCache.get(clientIdUrl);
    if (
      cached &&
      Date.now() - cached.fetchedAt < OAuthServerImpl.CIMD_CACHE_TTL_MS
    ) {
      return cached.redirectUris;
    }

    let parsed: URL;
    try {
      parsed = new URL(clientIdUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (isPrivateCimdHost(parsed.hostname)) return null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      let body: string;
      try {
        // No redirects — CIMD metadata documents must be served directly at
        // the registered client_id URL. Following Location headers from an
        // attacker-controlled server could bypass the isPrivateCimdHost() guard
        // regardless of per-hop re-validation.
        const resp = await fetch(clientIdUrl, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
          redirect: "error",
        });
        if (!resp.ok) return null;
        // Stream with size cap to prevent OOM
        const reader = resp.body?.getReader();
        if (!reader) return null;
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > OAuthServerImpl.CIMD_MAX_BYTES) {
            reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(value);
        }
        body = Buffer.concat(chunks).toString("utf8");
      } finally {
        clearTimeout(timeout);
      }

      const doc = JSON.parse(body) as Record<string, unknown>;
      const uris = doc.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0) return null;
      const redirectUris = uris.filter(
        (u) => typeof u === "string",
      ) as string[];
      if (redirectUris.length === 0) return null;

      this.cimdCache.set(clientIdUrl, { redirectUris, fetchedAt: Date.now() });
      return redirectUris;
    } catch {
      return null;
    }
  }

  private async parseAuthorizeParams(url: URL): Promise<{
    error?: string;
    clientId?: string;
    redirectUri?: string;
    codeChallenge?: string;
    scope?: string;
    state?: string;
  }> {
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

    // CIMD: if client_id is an HTTPS URL, fetch its metadata document to get
    // redirect_uris dynamically (SEP-991 / Claude Code v2.1.81+).
    // Otherwise fall back to the pre-registered client map.
    let allowedRedirectUris: string[] | undefined;
    if (clientId.startsWith("https://")) {
      const cimdUris = await this.fetchCimd(clientId);
      if (!cimdUris) return { error: "invalid_client" };
      allowedRedirectUris = cimdUris;
      // Register the client dynamically so the POST handler can look it up
      if (!this.registeredClients.has(clientId)) {
        this.registeredClients.set(clientId, {
          redirectUris: cimdUris,
          issuedAt: Date.now(),
        });
      }
    } else {
      const registered = this.registeredClients.get(clientId);
      allowedRedirectUris = registered?.redirectUris;
    }

    if (!allowedRedirectUris?.includes(redirectUri)) {
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
    flowId?: string;
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
      <input type="hidden" name="flow_id"        value="${e(opts.flowId ?? "")}">
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
