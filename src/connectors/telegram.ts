/**
 * Telegram connector — send messages via a Telegram bot, read chat info
 * and recent updates.
 *
 * Auth: bot token from @BotFather (Telegram → search "BotFather" → /newbot).
 *   - Env var: TELEGRAM_BOT_TOKEN
 *   - Stored: getSecretJsonSync("telegram") → TelegramTokens
 *   - Telegram's Bot API embeds the token in the URL PATH, not a header
 *     (`https://api.telegram.org/bot<TOKEN>/<method>`) — unlike every other
 *     connector in this directory. buildUrl() below is the one place that
 *     matters; nothing else needs to know about this quirk.
 *
 * Read tools: getMe (health check), getChat, getUpdates.
 * Write tools: sendMessage.
 *
 * A bot can only message chats it has been added to / that have started a
 * conversation with it — there is no OAuth scope model here, Telegram's
 * own chat-membership rules are the access boundary.
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const TELEGRAM_BASE = "https://api.telegram.org";

export interface TelegramTokens {
  token: string;
  botUsername?: string;
  botId?: number;
  connected_at: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  text?: string;
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export class TelegramConnector extends BaseConnector {
  readonly providerName = "telegram";

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Telegram not connected. Run: patchwork-os connect telegram or set TELEGRAM_BOT_TOKEN",
      );
    }
    return {
      token: tokens.token,
      scopes: ["send", "read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(this.buildUrl(token, "getMe"));
        const body = (await res.json()) as TelegramApiResponse<unknown>;
        if (!res.ok || !body.ok) throw { res, body };
        return body;
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (
      typeof error === "object" &&
      error !== null &&
      "res" in error &&
      "body" in error
    ) {
      const { res, body } = error as {
        res: Response;
        body: TelegramApiResponse<unknown>;
      };
      const s = res.status || body.error_code || 0;
      const desc = body.description ?? `HTTP ${s}`;
      if (s === 401 || s === 403)
        return {
          code: "auth_expired",
          message: `Telegram authentication failed — ${desc}`,
          retryable: false,
          suggestedAction: "patchwork-os connect telegram",
        };
      if (s === 400)
        return {
          code: "validation_error",
          message: `Telegram rejected the request — ${desc}`,
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: `Telegram chat/resource not found — ${desc}`,
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: `Telegram rate limit exceeded — ${desc}`,
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Telegram API error: ${desc}`,
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
          message: `Cannot connect to Telegram: ${error.message}`,
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
      id: "telegram",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.botUsername ? `@${tokens.botUsername}` : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async sendMessage(params: {
    chatId: string | number;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  }): Promise<TelegramMessage> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(this.buildUrl(token, "sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chatId,
          text: params.text,
          ...(params.parseMode && { parse_mode: params.parseMode }),
        }),
      });
      const body = (await res.json()) as TelegramApiResponse<TelegramMessage>;
      if (!res.ok || !body.ok) throw { res, body };
      return body.result as TelegramMessage;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getChat(chatId: string | number): Promise<TelegramChat> {
    const result = await this.apiCall(async (token) => {
      const url = new URL(this.buildUrl(token, "getChat"));
      url.searchParams.set("chat_id", String(chatId));
      const res = await fetch(url);
      const body = (await res.json()) as TelegramApiResponse<TelegramChat>;
      if (!res.ok || !body.ok) throw { res, body };
      return body.result as TelegramChat;
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getUpdates(
    params: { offset?: number; limit?: number } = {},
  ): Promise<{ updates: TelegramUpdate[] }> {
    const result = await this.apiCall(async (token) => {
      const url = new URL(this.buildUrl(token, "getUpdates"));
      if (params.offset !== undefined)
        url.searchParams.set("offset", String(params.offset));
      url.searchParams.set("limit", String(params.limit ?? 25));
      const res = await fetch(url);
      const body = (await res.json()) as TelegramApiResponse<TelegramUpdate[]>;
      if (!res.ok || !body.ok) throw { res, body };
      return { updates: body.result ?? [] };
    });

    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Telegram embeds the bot token in the URL path, not a header. */
  private buildUrl(token: string, method: string): string {
    return `${TELEGRAM_BASE}/bot${token}/${method}`;
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): TelegramTokens | null {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken) {
    return {
      token: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<TelegramTokens>("telegram");
}

export function saveTokens(tokens: TelegramTokens): void {
  storeSecretJsonSync("telegram", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("telegram");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: TelegramConnector | null = null;

function resetTelegramConnector(): void {
  _instance = null;
}

export function getTelegramConnector(): TelegramConnector {
  if (!_instance) {
    _instance = new TelegramConnector();
  }
  return _instance;
}

export { getTelegramConnector as telegram };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/connectorRoutes.ts under /connections/telegram/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/telegram/connect  { token }
 */
export async function handleTelegramConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let token: string;

  try {
    const parsed = JSON.parse(body) as { token?: unknown };
    if (typeof parsed.token !== "string" || !parsed.token) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "token is required" }),
      };
    }
    token = parsed.token;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${TELEGRAM_BASE}/bot${token}/getMe`);
    const detail = (await res.json().catch(() => ({}))) as TelegramApiResponse<{
      id: number;
      username?: string;
    }>;
    if (!res.ok || !detail.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Telegram (${detail.description ?? `HTTP ${res.status}`}) — check bot token`,
        }),
      };
    }

    const tokens: TelegramTokens = {
      token,
      botUsername: detail.result?.username,
      botId: detail.result?.id,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetTelegramConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        botUsername: tokens.botUsername,
        connectedAt: tokens.connected_at,
      }),
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
 * POST /connections/telegram/test
 */
export async function handleTelegramTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Telegram not connected" }),
    };
  }
  try {
    const connector = getTelegramConnector();
    const check = await connector.healthCheck();
    return {
      status: check.ok ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        check.ok ? { ok: true } : { ok: false, error: check.error?.message },
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
 * DELETE /connections/telegram
 */
export function handleTelegramDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetTelegramConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
