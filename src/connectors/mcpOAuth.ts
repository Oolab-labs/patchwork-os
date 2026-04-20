/**
 * OAuth 2.1 PKCE helper for upstream MCP servers.
 *
 * Supports two vendor modes:
 *   - dyn-reg (Linear, Sentry): RFC 7591 dynamic client registration.
 *     Registration data cached alongside tokens so we don't re-register every run.
 *   - preregistered (GitHub): uses a hardcoded client_id + PKCE-only flow.
 *
 * Token files: ~/.patchwork/tokens/<vendor>-mcp.json (mode 0600)
 *
 * Flow:
 *   1. startAuthorize({ vendor, config }) -> { url, state }
 *      Dashboard opens `url` in a popup; stores `state` to correlate callback.
 *   2. server.ts callback route calls completeAuthorize({ vendor, config, code, state })
 *      -> persisted token file.
 *   3. getAccessToken({ vendor }) reads token, refreshes if needed.
 *   4. revoke({ vendor }) hits the revocation endpoint + deletes file.
 */

import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ── Config types ─────────────────────────────────────────────────────────────

export type VendorId = "github" | "linear" | "sentry";

export interface VendorConfig {
  vendor: VendorId;
  /** Base issuer (authorization server), used for discovery. */
  issuer: string;
  /** Explicit endpoints (overrides discovery). */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  /** Scopes requested in authorize URL. */
  scopes: string[];
  /** Redirect URI — must match what's registered / what the dashboard uses. */
  redirectUri: string;
  /** If true, use RFC 7591 dynamic client registration. */
  useDynamicRegistration: boolean;
  /** If useDynamicRegistration=false, this client_id is used. */
  preregisteredClientId?: string;
  /** Human-friendly client name for dyn-reg. */
  clientName?: string;
}

// ── Known vendor configs ─────────────────────────────────────────────────────

function defaultRedirectBase(): string {
  return (
    process.env.PATCHWORK_DASHBOARD_URL ?? "http://localhost:3200"
  ).replace(/\/$/, "");
}

function defaultBridgeBase(): string {
  const port = process.env.PATCHWORK_BRIDGE_PORT ?? "3101";
  return (
    process.env.PATCHWORK_BRIDGE_URL ?? `http://localhost:${port}`
  ).replace(/\/$/, "");
}

export function vendorConfig(vendor: VendorId): VendorConfig {
  const redirectBase = defaultRedirectBase();
  const bridgeBase = defaultBridgeBase();
  switch (vendor) {
    case "github":
      return {
        vendor,
        issuer: "https://github.com/login/oauth",
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        revocationEndpoint: undefined, // GitHub OAuth apps use a different revoke path; best-effort delete only
        scopes: ["repo", "read:org", "read:user"],
        redirectUri: `${redirectBase}/connections/github/callback`,
        useDynamicRegistration: false,
        preregisteredClientId: process.env.PATCHWORK_GITHUB_CLIENT_ID ?? "",
        clientName: "Patchwork OS",
      };
    case "linear":
      return {
        vendor,
        issuer: "https://mcp.linear.app",
        authorizationEndpoint: "https://mcp.linear.app/authorize",
        tokenEndpoint: "https://mcp.linear.app/token",
        registrationEndpoint: "https://mcp.linear.app/register",
        revocationEndpoint: "https://mcp.linear.app/token", // per discovery doc
        scopes: [],
        redirectUri: `${bridgeBase}/connections/linear/callback`,
        useDynamicRegistration: true,
        clientName: "Patchwork OS",
      };
    case "sentry":
      return {
        vendor,
        issuer: "https://mcp.sentry.dev",
        authorizationEndpoint: "https://mcp.sentry.dev/oauth/authorize",
        tokenEndpoint: "https://mcp.sentry.dev/oauth/token",
        registrationEndpoint: "https://mcp.sentry.dev/oauth/register",
        revocationEndpoint: "https://mcp.sentry.dev/oauth/token",
        scopes: ["org:read", "project:write", "event:write"],
        redirectUri: `${bridgeBase}/connections/sentry/callback`,
        useDynamicRegistration: true,
        clientName: "Patchwork OS",
      };
  }
}

// ── Persistent token store ───────────────────────────────────────────────────

export interface McpTokenFile {
  vendor: VendorId;
  client_id: string;
  client_secret?: string; // only set if dyn-reg returned one (Linear/Sentry allow "none")
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  connected_at: string;
  /** Vendor-specific profile info captured at connect-time for UI display. */
  profile?: Record<string, string>;
}

function tokenPath(vendor: VendorId): string {
  return path.join(homedir(), ".patchwork", "tokens", `${vendor}-mcp.json`);
}

export function loadTokenFile(vendor: VendorId): McpTokenFile | null {
  const p = tokenPath(vendor);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as McpTokenFile;
  } catch {
    return null;
  }
}

function saveTokenFile(file: McpTokenFile): void {
  const p = tokenPath(file.vendor);
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function deleteTokenFile(vendor: VendorId): void {
  const p = tokenPath(vendor);
  if (existsSync(p)) unlinkSync(p);
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function genVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

function challenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

// ── In-memory pending-authorization state ────────────────────────────────────

interface PendingAuth {
  vendor: VendorId;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  expiresAt: number;
}

const pending = new Map<string, PendingAuth>();

function gcPending(): void {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (v.expiresAt < now) pending.delete(k);
  }
}

// ── Dyn-reg ──────────────────────────────────────────────────────────────────

interface RegistrationResponse {
  client_id: string;
  client_secret?: string;
}

async function dynamicRegister(
  config: VendorConfig,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!config.registrationEndpoint) {
    throw new Error(`${config.vendor}: no registration endpoint configured`);
  }
  const body = {
    client_name: config.clientName ?? "Patchwork OS",
    redirect_uris: [config.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: config.scopes.join(" "),
  };
  const res = await fetch(config.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 300);
    throw new Error(
      `${config.vendor} dyn-reg failed ${res.status}: ${snippet}`,
    );
  }
  const json = (await res.json()) as RegistrationResponse;
  if (!json.client_id)
    throw new Error(`${config.vendor} dyn-reg missing client_id`);
  return { clientId: json.client_id, clientSecret: json.client_secret };
}

// ── Authorize flow ───────────────────────────────────────────────────────────

/**
 * Returns the authorize URL for the popup, and a `state` cookie value
 * the callback must match. For dyn-reg vendors, registers a fresh client
 * if we don't have one yet (re-uses existing one from token file on reconnect).
 */
export async function startAuthorize(
  config: VendorConfig,
): Promise<{ url: string; state: string }> {
  gcPending();

  let clientId = config.preregisteredClientId ?? "";
  let clientSecret: string | undefined;

  if (config.useDynamicRegistration) {
    // Re-use cached registration if available
    const existing = loadTokenFile(config.vendor);
    if (existing?.client_id) {
      clientId = existing.client_id;
      clientSecret = existing.client_secret;
    } else {
      const reg = await dynamicRegister(config);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    }
  }
  if (!clientId) {
    throw new Error(
      `${config.vendor}: client_id not configured (set PATCHWORK_${config.vendor.toUpperCase()}_CLIENT_ID)`,
    );
  }

  const verifier = genVerifier();
  const state = base64url(crypto.randomBytes(24));
  pending.set(state, {
    vendor: config.vendor,
    verifier,
    clientId,
    clientSecret,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  });
  if (config.scopes.length) params.set("scope", config.scopes.join(" "));

  const authorizeUrl = config.authorizationEndpoint;
  if (!authorizeUrl)
    throw new Error(`${config.vendor}: no authorization_endpoint`);
  return { url: `${authorizeUrl}?${params.toString()}`, state };
}

export interface CompleteResult {
  ok: true;
  profile?: Record<string, string>;
}

async function exchangeCode(
  config: VendorConfig,
  code: string,
  verifier: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}> {
  if (!config.tokenEndpoint)
    throw new Error(`${config.vendor}: no token_endpoint`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 300);
    throw new Error(
      `${config.vendor} token exchange ${res.status}: ${snippet}`,
    );
  }
  // GitHub returns form-encoded by default unless Accept: application/json is honored
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await res.text();
    const p = new URLSearchParams(text);
    if (p.get("error"))
      throw new Error(
        `${config.vendor}: ${p.get("error_description") ?? p.get("error")}`,
      );
    return {
      access_token: p.get("access_token") ?? "",
      refresh_token: p.get("refresh_token") ?? undefined,
      expires_in: p.get("expires_in") ? Number(p.get("expires_in")) : undefined,
      scope: p.get("scope") ?? undefined,
    };
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

/** Complete the authorize flow. Persists token file. */
export async function completeAuthorize(
  config: VendorConfig,
  code: string,
  state: string,
  profile?: Record<string, string>,
): Promise<CompleteResult> {
  gcPending();
  const p = pending.get(state);
  if (!p) throw new Error(`${config.vendor}: invalid or expired state`);
  pending.delete(state);
  if (p.vendor !== config.vendor)
    throw new Error(`${config.vendor}: vendor mismatch on state`);

  const tok = await exchangeCode(
    config,
    code,
    p.verifier,
    p.clientId,
    p.clientSecret,
  );
  if (!tok.access_token)
    throw new Error(`${config.vendor}: empty access_token`);
  const expiresAt = tok.expires_in
    ? Date.now() + tok.expires_in * 1000
    : undefined;

  saveTokenFile({
    vendor: config.vendor,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: expiresAt,
    scope: tok.scope,
    connected_at: new Date().toISOString(),
    profile,
  });
  return { ok: true, profile };
}

// ── Token refresh ────────────────────────────────────────────────────────────

async function refreshIfNeeded(
  config: VendorConfig,
  file: McpTokenFile,
): Promise<McpTokenFile> {
  const buffer = 60_000;
  if (!file.expires_at || Date.now() < file.expires_at - buffer) return file;
  if (!file.refresh_token) return file; // some vendors don't issue refresh tokens
  if (!config.tokenEndpoint) return file;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: file.refresh_token,
    client_id: file.client_id,
  });
  if (file.client_secret) body.set("client_secret", file.client_secret);

  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Leave file as-is; caller will get 401 on next API call and re-auth
    return file;
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const updated: McpTokenFile = {
    ...file,
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? file.refresh_token,
    expires_at: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : undefined,
  };
  saveTokenFile(updated);
  return updated;
}

export async function getAccessToken(vendor: VendorId): Promise<string> {
  const file = loadTokenFile(vendor);
  if (!file) throw new Error(`${vendor}: not connected`);
  const config = vendorConfig(vendor);
  const fresh = await refreshIfNeeded(config, file);
  return fresh.access_token;
}

// ── Revocation ───────────────────────────────────────────────────────────────

export async function revoke(vendor: VendorId): Promise<void> {
  const file = loadTokenFile(vendor);
  const config = vendorConfig(vendor);
  if (file && config.revocationEndpoint) {
    const body = new URLSearchParams({
      token: file.access_token,
      client_id: file.client_id,
    });
    if (file.client_secret) body.set("client_secret", file.client_secret);
    await fetch(config.revocationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }).catch(() => {});
  }
  deleteTokenFile(vendor);
}

export function isConnected(vendor: VendorId): boolean {
  return loadTokenFile(vendor) !== null;
}
