/**
 * Discord connector — read guilds, channels, messages.
 *
 * OAuth 2.0 Authorization Code Grant. Discord is a confidential client
 * (bridge holds the client secret), so PKCE is not required. Refresh
 * tokens are issued; access tokens expire (typically 7 days).
 *
 * Auth: standard OAuth 2.0 with `client_id` + `client_secret` + `redirect_uri`.
 *   - Env vars: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET (mirrors slack)
 *   - Stored: getSecretJsonSync("discord") → DiscordTokens
 *   - Header: Authorization: Bearer <access_token>
 *
 * Tools: getCurrentUser, listGuilds, listChannels, listMessages (read);
 *   sendMessage (write).
 *
 * NOTE on writes: Discord's REST API does NOT permit user-context OAuth tokens
 * to send messages on behalf of the user — only bot-scope tokens can hit
 * `POST /channels/{id}/messages`. The current connector authenticates as a
 * regular user (scopes: identify, guilds, messages.read), so `sendMessage`
 * will return a `permission_denied` error until the user re-authenticates
 * with the `bot` scope. The method is wired correctly; the gap is the auth
 * scope, which is left to operators to upgrade when they want write access.
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/discord/auth     — redirect to Discord consent
 *   GET    /connections/discord/callback — exchange code for tokens
 *   POST   /connections/discord/test     — ping Discord API
 *   DELETE /connections/discord          — clear stored tokens
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 * Token refresh is delegated to BaseConnector.refreshToken() via apiCall.
 */

import crypto from "node:crypto";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "./baseConnector.js";
import { escHtml } from "./htmlEscape.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_AUTH_URL = "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_REVOKE_URL = "https://discord.com/api/oauth2/token/revoke";
const SCOPES = ["identify", "guilds", "messages.read"];

export interface DiscordTokens {
  access_token: string;
  refresh_token?: string;
  /** ms since epoch; absolute, not relative */
  expires_at?: number;
  scope?: string;
  token_type?: string;
  /** stored at auth time so refresh works even if env vars are absent */
  _client_id?: string;
  _client_secret?: string;
  username?: string;
  user_id?: string;
  connected_at: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
  topic?: string | null;
  position?: number;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
  };
}

// ── Config ───────────────────────────────────────────────────────────────────

function clientId(): string {
  return process.env.DISCORD_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.DISCORD_CLIENT_SECRET ?? "";
}

function redirectUri(): string {
  const base = (
    process.env.PATCHWORK_BRIDGE_URL ??
    `http://localhost:${process.env.PATCHWORK_BRIDGE_PORT ?? "3101"}`
  ).replace(/\/$/, "");
  return `${base}/connections/discord/callback`;
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): DiscordTokens | null {
  return getSecretJsonSync<DiscordTokens>("discord");
}

export function saveTokens(tokens: DiscordTokens): void {
  storeSecretJsonSync("discord", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("discord");
  } catch {
    // ignore
  }
}

export function isConnected(): boolean {
  return loadTokens() !== null;
}

// ── State (CSRF) ─────────────────────────────────────────────────────────────
// In-memory map keyed by hex random — short-lived (5 min). Mirrors gmail's
// approach (Set + setTimeout) rather than slack's on-disk file because we
// don't need cross-process resumption for an OAuth round-trip.

import { createOAuthStateStore } from "./oauthStateStore.js";

const STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = createOAuthStateStore({ ttlMs: STATE_TTL_MS });

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  if (!pendingStates.add(state)) {
    throw new Error(
      "OAuth state store full — too many concurrent authorize requests",
    );
  }
  return state;
}

function consumeState(state: string): boolean {
  return pendingStates.consume(state);
}

// ── Connector class ──────────────────────────────────────────────────────────

export class DiscordConnector extends BaseConnector {
  readonly providerName = "discord";

  protected getOAuthConfig(): OAuthConfig | null {
    // Resolve credentials from env first, then fall back to credentials we
    // stored at auth time (so refresh keeps working even if env is unset).
    const tokens = loadTokens();
    const id = clientId() || tokens?._client_id || "";
    const secret = clientSecret() || tokens?._client_secret || "";
    if (!id || !secret) return null;
    return {
      clientId: id,
      clientSecret: secret,
      tokenEndpoint: DISCORD_TOKEN_URL,
      scopes: SCOPES,
    };
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Discord not connected. Visit /connections/discord/auth to authorize.",
      );
    }
    return {
      token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_at ? new Date(tokens.expires_at) : undefined,
      scopes: tokens.scope ? tokens.scope.split(" ") : SCOPES,
    };
  }

  /**
   * Persist refreshed tokens after BaseConnector.refreshToken() updates
   * `this.auth`. BaseConnector calls `saveTokens()` (its own method on the
   * tokenStorage StoredToken shape); we additionally mirror to our
   * Discord-specific JSON so loadTokens() keeps working for HTTP probes.
   */
  override async saveTokens(): Promise<void> {
    await super.saveTokens();
    if (!this.auth) return;
    const existing = loadTokens();
    saveTokens({
      access_token: this.auth.token,
      refresh_token: this.auth.refreshToken,
      expires_at: this.auth.expiresAt
        ? this.auth.expiresAt.getTime()
        : undefined,
      scope: this.auth.scopes?.join(" "),
      token_type: existing?.token_type ?? "Bearer",
      _client_id: existing?._client_id,
      _client_secret: existing?._client_secret,
      username: existing?.username,
      user_id: existing?.user_id,
      connected_at: existing?.connected_at ?? new Date().toISOString(),
    });
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
          headers: this.buildHeaders(token),
        });
        if (!res.ok) throw res;
        return res.json();
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error instanceof Response) {
      const s = error.status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Discord authentication failed — token expired or revoked",
          retryable: true,
          suggestedAction: "Reconnect via /connections/discord/auth",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message:
            "Discord write requires bot scope — re-authenticate with the bot scope to enable sendMessage. (Other 403s indicate insufficient permissions for this resource.)",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Discord resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Discord API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Discord API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to Discord: ${error.message}`,
          retryable: true,
        };
      }
    }
    return {
      code: "provider_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "discord",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.username,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getCurrentUser(): Promise<DiscordUser> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<DiscordUser>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DiscordUser;
  }

  async listGuilds(params: { limit?: number } = {}): Promise<DiscordGuild[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        limit: String(Math.min(params.limit ?? 100, 200)),
      });
      const res = await fetch(`${DISCORD_API_BASE}/users/@me/guilds?${qs}`, {
        headers: this.buildHeaders(token),
      });
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<DiscordGuild[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DiscordGuild[];
  }

  async listChannels(guildId: string): Promise<DiscordChannel[]> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/channels`,
        { headers: this.buildHeaders(token) },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<DiscordChannel[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    // Filter to text channels only (type 0). Voice/category/thread channels
    // are excluded — recipe consumers only care about messageable text rooms.
    return (result.data as DiscordChannel[]).filter((c) => c.type === 0);
  }

  async listMessages(
    channelId: string,
    params: { limit?: number } = {},
  ): Promise<DiscordMessage[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams({
        limit: String(Math.min(params.limit ?? 50, 100)),
      });
      const res = await fetch(
        `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages?${qs}`,
        { headers: this.buildHeaders(token) },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<DiscordMessage[]>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DiscordMessage[];
  }

  /**
   * Send a message to a Discord channel.
   *
   * Caveat: requires bot-scope OAuth — regular user-context tokens cannot
   * send via this endpoint. On 403 the connector surfaces a
   * `permission_denied` error pointing at the bot-scope requirement.
   *
   * @param channelId Discord channel id (non-empty)
   * @param body { content (≤2000 chars), tts? defaults false }
   */
  async sendMessage(
    channelId: string,
    body: { content: string; tts?: boolean },
  ): Promise<DiscordMessage> {
    if (!channelId || typeof channelId !== "string") {
      throw new Error("sendMessage requires a non-empty channelId");
    }
    if (!body?.content || typeof body.content !== "string") {
      throw new Error("sendMessage requires a non-empty content string");
    }
    if (body.content.length > 2000) {
      throw new Error(
        `sendMessage content exceeds Discord's 2000-character limit (${body.content.length})`,
      );
    }
    const payload = {
      content: body.content,
      tts: body.tts ?? false,
    };

    const result = await this.apiCall(async (token) => {
      const res = await fetch(
        `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: this.buildHeaders(token),
          body: JSON.stringify(payload),
        },
      );
      this.captureRateLimit(res);
      if (!res.ok) throw res;
      return res.json() as Promise<DiscordMessage>;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data as DiscordMessage;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private captureRateLimit(res: Response): void {
    this.updateRateLimitFromHeaders({
      "x-ratelimit-remaining":
        res.headers.get("x-ratelimit-remaining") ?? undefined,
      "x-ratelimit-reset": res.headers.get("x-ratelimit-reset") ?? undefined,
      "retry-after": res.headers.get("retry-after") ?? undefined,
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: DiscordConnector | null = null;

function resetDiscordConnector(): void {
  _instance = null;
}

export function getDiscordConnector(): DiscordConnector {
  if (!_instance) {
    _instance = new DiscordConnector();
  }
  return _instance;
}

export { getDiscordConnector as discord };

// ── HTTP Handlers ────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

/**
 * GET /connections/discord/auth — redirect to Discord consent screen.
 */
export function handleDiscordAuthorize(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error:
          "Discord connector not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.",
      }),
    };
  }
  const state = generateState();
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return {
    status: 302,
    body: "",
    redirect: `${DISCORD_AUTH_URL}?${params.toString()}`,
  };
}

/**
 * GET /connections/discord/callback — exchange code for tokens.
 */
export async function handleDiscordCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Discord connect failed</h2><pre>${escHtml(error)}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Discord connect failed</h2><pre>missing code or state</pre></body></html>`,
    };
  }
  if (!consumeState(state)) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Discord connect failed</h2><pre>invalid or expired state</pre></body></html>`,
    };
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      client_secret: clientSecret(),
    });
    const res = await fetch(DISCORD_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token exchange HTTP ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!json.access_token) {
      throw new Error("Token exchange returned no access_token");
    }

    // Fetch user info so we can show "connected as <username>" on the dash.
    let username: string | undefined;
    let userId: string | undefined;
    try {
      const userRes = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (userRes.ok) {
        const u = (await userRes.json()) as DiscordUser;
        username = u.global_name ?? u.username;
        userId = u.id;
      }
    } catch {
      // best-effort — don't fail connect just because /users/@me hiccuped
    }

    const expiresAt =
      typeof json.expires_in === "number" && json.expires_in > 0
        ? Date.now() + json.expires_in * 1000
        : undefined;

    saveTokens({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: expiresAt,
      scope: json.scope,
      token_type: json.token_type ?? "Bearer",
      _client_id: clientId() || undefined,
      _client_secret: clientSecret() || undefined,
      username,
      user_id: userId,
      connected_at: new Date().toISOString(),
    });
    resetDiscordConnector();

    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>Discord connected${username ? ` as ${escHtml(username)}` : ""}</h2><script>try { window.opener.postMessage('patchwork:discord:connected', '*'); } catch(_) {} window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Discord connect failed</h2><pre>${escHtml(err instanceof Error ? err.message : String(err))}</pre></body></html>`,
    };
  }
}

/**
 * POST /connections/discord/test — verify stored token works.
 */
export async function handleDiscordTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Discord not connected" }),
    };
  }
  try {
    const connector = getDiscordConnector();
    const check = await connector.healthCheck();
    return {
      status: check.ok ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        check.ok
          ? { ok: true, username: tokens.username }
          : { ok: false, error: check.error?.message },
      ),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * DELETE /connections/discord — clear stored tokens (and revoke at Discord).
 */
export async function handleDiscordDisconnect(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  // Best-effort revoke at Discord. Slack doesn't do this but Discord exposes
  // a standard RFC 7009 revocation endpoint, and the spec allowlist permits
  // it. Failure to revoke must NOT block the local disconnect.
  if (tokens?.access_token && isConfigured()) {
    try {
      await fetch(DISCORD_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.access_token,
          client_id: clientId(),
          client_secret: clientSecret(),
        }).toString(),
      });
    } catch {
      // ignore — still drop local tokens
    }
  }
  clearTokens();
  resetDiscordConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
