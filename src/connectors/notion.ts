/**
 * Notion connector — read/write Notion databases and pages via the Notion API.
 *
 * Auth: API token (internal integration) or OAuth 2.0 (public integration).
 *   - Env var: NOTION_TOKEN overrides stored token for CI/headless use.
 *   - Stored: getSecretJsonSync("notion") → NotionTokens
 *
 * Tools: queryDatabase, getPage, search, createPage, appendBlock
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import { getSecretJsonSync, storeSecretJsonSync } from "./tokenStorage.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionTokens {
  accessToken: string;
  workspaceName?: string;
  workspaceId?: string;
  botId?: string;
  connected_at: string;
}

// ------------------------------------------------------------------ API types

export interface NotionUser {
  object: "user";
  id: string;
  name?: string;
  avatar_url?: string;
  type: "person" | "bot";
}

export interface NotionRichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  plain_text: string;
  href?: string | null;
}

export interface NotionPage {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  url: string;
  properties: Record<string, unknown>;
  parent: { type: string; database_id?: string; page_id?: string };
}

export interface NotionDatabase {
  object: "database";
  id: string;
  title: NotionRichText[];
  description?: NotionRichText[];
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, unknown>;
}

export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  created_time: string;
  last_edited_time: string;
  has_children: boolean;
  [key: string]: unknown;
}

export interface NotionQueryResult {
  object: "list";
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionSearchResult {
  object: "list";
  results: Array<NotionPage | NotionDatabase>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface CreatePageParams {
  parentId: string;
  parentType: "database" | "page";
  title: string;
  properties?: Record<string, unknown>;
  content?: string;
}

export interface AppendBlockParams {
  pageId: string;
  content: string;
  blockType?:
    | "paragraph"
    | "bulleted_list_item"
    | "numbered_list_item"
    | "heading_1"
    | "heading_2"
    | "heading_3"
    | "quote"
    | "code";
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): NotionTokens | null {
  const envToken = process.env.NOTION_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<NotionTokens>("notion");
}

export function saveTokens(tokens: NotionTokens): void {
  storeSecretJsonSync("notion", tokens);
}

export function clearTokens(): void {
  try {
    const p = path.join(homedir(), ".patchwork", "tokens", "notion.json");
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------------ connector

export class NotionConnector extends BaseConnector {
  readonly providerName = "notion";
  // Cached after authenticate(); re-read in getStatus() to stay fresh
  protected cachedTokens: NotionTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Notion not connected. Run: patchwork connect notion  or set NOTION_TOKEN",
      );
    }
    this.cachedTokens = tokens;
    return { token: tokens.accessToken };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const res = await fetch(`${NOTION_API}/users/me`, {
          headers: this.buildHeaders(token),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<NotionUser>;
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (
      error instanceof Response ||
      (error && typeof error === "object" && "status" in error)
    ) {
      const status = (error as { status: number }).status;
      if (status === 401)
        return {
          code: "auth_expired",
          message: "Notion token expired or invalid",
          retryable: false,
          suggestedAction: "Reconnect: patchwork connect notion",
        };
      if (status === 403)
        return {
          code: "permission_denied",
          message: "Notion integration lacks permission for this resource",
          retryable: false,
          suggestedAction: "Share the page/database with your integration",
        };
      if (status === 404)
        return {
          code: "not_found",
          message: "Notion page or database not found",
          retryable: false,
        };
      if (status === 429)
        return {
          code: "rate_limited",
          message: "Notion API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Notion API error: HTTP ${status}`,
        retryable: status >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot reach Notion API: ${error.message}`,
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
      id: "notion",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.workspaceName,
    };
  }

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    };
  }

  // ---------------------------------------------------------------- read ops

  async queryDatabase(
    databaseId: string,
    filter?: Record<string, unknown>,
    sorts?: Array<{ property: string; direction: "ascending" | "descending" }>,
    pageSize = 20,
  ): Promise<NotionQueryResult> {
    const result = await this.apiCall(async (token) => {
      const body: Record<string, unknown> = {
        page_size: Math.min(pageSize, 100),
      };
      if (filter) body.filter = filter;
      if (sorts) body.sorts = sorts;
      const res = await fetch(
        `${NOTION_API}/databases/${normalizeId(databaseId)}/query`,
        {
          method: "POST",
          headers: this.buildHeaders(token),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<NotionQueryResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getPage(pageId: string): Promise<NotionPage> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${NOTION_API}/pages/${normalizeId(pageId)}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<NotionPage>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async search(
    query: string,
    filterType?: "page" | "database",
    pageSize = 10,
  ): Promise<NotionSearchResult> {
    const result = await this.apiCall(async (token) => {
      const body: Record<string, unknown> = {
        query,
        page_size: Math.min(pageSize, 100),
      };
      if (filterType) body.filter = { value: filterType, property: "object" };
      const res = await fetch(`${NOTION_API}/search`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<NotionSearchResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  // ---------------------------------------------------------------- write ops

  async createPage(params: CreatePageParams): Promise<NotionPage> {
    const result = await this.apiCall(async (token) => {
      const parent =
        params.parentType === "database"
          ? { database_id: normalizeId(params.parentId) }
          : { page_id: normalizeId(params.parentId) };

      const properties: Record<string, unknown> = params.properties ?? {};
      // Set title property — key is "title" for pages, "Name" for database rows
      const titleKey = params.parentType === "database" ? "Name" : "title";
      properties[titleKey] = {
        title: [{ text: { content: params.title } }],
      };

      const body: Record<string, unknown> = { parent, properties };
      if (params.content) {
        body.children = [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: params.content } }],
            },
          },
        ];
      }

      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<NotionPage>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async appendBlock(
    params: AppendBlockParams,
  ): Promise<{ results: NotionBlock[] }> {
    const result = await this.apiCall(async (token) => {
      const type = params.blockType ?? "paragraph";
      const richText = [{ type: "text", text: { content: params.content } }];
      const block: Record<string, unknown> = {
        object: "block",
        type,
        [type]: { rich_text: richText },
      };

      const res = await fetch(
        `${NOTION_API}/blocks/${normalizeId(params.pageId)}/children`,
        {
          method: "PATCH",
          headers: this.buildHeaders(token),
          body: JSON.stringify({ children: [block] }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<{ results: NotionBlock[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }
}

// ------------------------------------------------------------------ helpers

/** Normalize Notion IDs — strip hyphens if present, add back in UUID format. */
function normalizeId(id: string): string {
  const stripped = id.replace(/-/g, "");
  if (stripped.length === 32) {
    return `${stripped.slice(0, 8)}-${stripped.slice(8, 12)}-${stripped.slice(12, 16)}-${stripped.slice(16, 20)}-${stripped.slice(20)}`;
  }
  return id;
}

// ------------------------------------------------------------------ singleton

let _instance: NotionConnector | null = null;

export function getNotionConnector(): NotionConnector {
  if (!_instance) _instance = new NotionConnector();
  return _instance;
}

export function resetNotionConnector(): void {
  _instance = null;
}

// ------------------------------------------------------------------ convenience re-exports

export { loadTokens as isConnected };

// ------------------------------------------------------------------ HTTP handlers
// Wired in src/server.ts under /connections/notion/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/notion/connect  { token: "secret_..." }
 * Stores the integration token and verifies it by calling /users/me.
 */
export async function handleNotionConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let token: string;
  try {
    const parsed = JSON.parse(body) as { token?: unknown };
    if (
      typeof parsed.token !== "string" ||
      !parsed.token.startsWith("secret_")
    ) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            'Notion integration token must start with "secret_". Find it at https://www.notion.so/my-integrations',
        }),
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
    const res = await fetch(`${NOTION_API}/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            "Token rejected by Notion API — check the token is valid and the integration is active",
        }),
      };
    }
    const user = (await res.json()) as {
      name?: string;
      bot?: { workspace_name?: string; owner?: { workspace_id?: string } };
    };
    const tokens: NotionTokens = {
      accessToken: token,
      workspaceName: user.bot?.workspace_name,
      workspaceId: user.bot?.owner?.workspace_id,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetNotionConnector();
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        workspace: tokens.workspaceName ?? "unknown",
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
 * POST /connections/notion/test
 * Verifies stored token is still valid.
 */
export async function handleNotionTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Notion not connected" }),
    };
  }
  try {
    const connector = getNotionConnector();
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
 * DELETE /connections/notion
 * Removes stored token.
 */
export function handleNotionDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetNotionConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
