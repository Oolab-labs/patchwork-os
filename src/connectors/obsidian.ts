/**
 * Obsidian connector — read/write notes via the Obsidian Local REST API plugin.
 *
 * Auth: API key (Bearer token) from plugin settings.
 *   - Env var: OBSIDIAN_API_KEY overrides stored key for CI/headless use.
 *   - Stored: getSecretJsonSync("obsidian") → ObsidianTokens
 *
 * Tools: listVault, readNote, writeNote, deleteNote, searchVault, appendToNote,
 *         getActiveNote, openNote, executeCommand, listCommands
 *
 * The plugin runs at https://127.0.0.1:27124 with a self-signed certificate.
 * All fetch calls use an undici Agent with rejectUnauthorized: false.
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import { getSecretJsonSync, storeSecretJsonSync } from "./tokenStorage.js";

const DEFAULT_BASE_URL = "https://127.0.0.1:27124";

// Reusable TLS agent that accepts the plugin's self-signed certificate.
const tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });

export interface ObsidianTokens {
  apiKey: string;
  baseUrl: string;
  connected_at: string;
}

// ------------------------------------------------------------------ API types

export interface ObsidianVaultEntry {
  path: string;
  type: "file" | "directory";
}

export interface ObsidianSearchMatch {
  filename: string;
  score: number;
  matches: string[];
}

export interface ObsidianCommand {
  id: string;
  name: string;
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): ObsidianTokens | null {
  const envKey = process.env.OBSIDIAN_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: DEFAULT_BASE_URL,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<ObsidianTokens>("obsidian");
}

export function saveTokens(tokens: ObsidianTokens): void {
  storeSecretJsonSync("obsidian", tokens);
}

export function clearTokens(): void {
  try {
    const p = path.join(homedir(), ".patchwork", "tokens", "obsidian.json");
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------------ connector

export class ObsidianConnector extends BaseConnector {
  readonly providerName = "obsidian";
  protected cachedTokens: ObsidianTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Obsidian not connected. Run: patchwork connect obsidian  or set OBSIDIAN_API_KEY",
      );
    }
    this.cachedTokens = tokens;
    return { token: tokens.apiKey };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const tokens = this.cachedTokens ?? loadTokens();
        const baseUrl = tokens?.baseUrl ?? DEFAULT_BASE_URL;
        const res = await undiciFetch(`${baseUrl}/vault/`, {
          dispatcher: tlsAgent,
          headers: buildHeaders(token),
        });
        if (!res.ok)
          throw Object.assign(new Error(`HTTP ${res.status}`), {
            status: res.status,
          });
        return res.json();
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error && typeof error === "object" && "status" in error) {
      const status = (error as { status: number }).status;
      if (status === 401 || status === 403)
        return {
          code: "auth_expired",
          message: "Obsidian API key rejected — check plugin settings",
          retryable: false,
          suggestedAction: "Reconnect: patchwork connect obsidian",
        };
      if (status === 404)
        return {
          code: "not_found",
          message: "Obsidian note or path not found",
          retryable: false,
        };
      return {
        code: "provider_error",
        message: `Obsidian API error: HTTP ${status}`,
        retryable: status >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ENOTFOUND")
      ) {
        return {
          code: "network_error",
          message: `Cannot reach Obsidian Local REST API: ${error.message}. Is the plugin running?`,
          retryable: true,
          suggestedAction:
            "Start Obsidian and enable the Local REST API plugin",
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
      id: "obsidian",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.baseUrl,
    };
  }

  private baseUrl(): string {
    return (this.cachedTokens ?? loadTokens())?.baseUrl ?? DEFAULT_BASE_URL;
  }

  // ---------------------------------------------------------------- vault ops

  async listVault(vaultPath?: string): Promise<ObsidianVaultEntry[]> {
    const result = await this.apiCall(async (token) => {
      const encoded = vaultPath ? encodeURIComponent(vaultPath) : "";
      const url = `${this.baseUrl()}/vault/${encoded ? `${encoded}/` : ""}`;
      const res = await undiciFetch(url, {
        dispatcher: tlsAgent,
        headers: buildHeaders(token),
      });
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return res.json() as Promise<{ files: string[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    const raw = result.data;
    return (raw.files ?? []).map((f: string) => ({
      path: f,
      type: f.endsWith("/") ? ("directory" as const) : ("file" as const),
    }));
  }

  async readNote(notePath: string): Promise<string> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(
        `${this.baseUrl()}/vault/${encodeURIComponent(notePath)}`,
        {
          dispatcher: tlsAgent,
          headers: buildHeaders(token),
        },
      );
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return res.text();
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async writeNote(
    notePath: string,
    content: string,
    append = false,
  ): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const method = append ? "POST" : "PUT";
      const res = await undiciFetch(
        `${this.baseUrl()}/vault/${encodeURIComponent(notePath)}`,
        {
          method,
          dispatcher: tlsAgent,
          headers: {
            ...buildHeaders(token),
            "Content-Type": "text/markdown",
          },
          body: content,
        },
      );
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  async appendToNote(notePath: string, content: string): Promise<void> {
    return this.writeNote(notePath, content, true);
  }

  async deleteNote(notePath: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(
        `${this.baseUrl()}/vault/${encodeURIComponent(notePath)}`,
        {
          method: "DELETE",
          dispatcher: tlsAgent,
          headers: buildHeaders(token),
        },
      );
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  async searchVault(query: string): Promise<ObsidianSearchMatch[]> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(
        `${this.baseUrl()}/search/simple/?query=${encodeURIComponent(query)}`,
        {
          method: "POST",
          dispatcher: tlsAgent,
          headers: buildHeaders(token),
        },
      );
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return res.json() as Promise<ObsidianSearchMatch[]>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getActiveNote(): Promise<string> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(`${this.baseUrl()}/active/`, {
        dispatcher: tlsAgent,
        headers: buildHeaders(token),
      });
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return res.text();
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async openNote(notePath: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(
        `${this.baseUrl()}/open/${encodeURIComponent(notePath)}`,
        {
          method: "POST",
          dispatcher: tlsAgent,
          headers: buildHeaders(token),
        },
      );
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  async listCommands(): Promise<ObsidianCommand[]> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(`${this.baseUrl()}/commands/`, {
        dispatcher: tlsAgent,
        headers: buildHeaders(token),
      });
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return res.json() as Promise<{ commands: ObsidianCommand[] }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data.commands ?? [];
  }

  async executeCommand(commandId: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const res = await undiciFetch(
        `${this.baseUrl()}/commands/${encodeURIComponent(commandId)}/execute`,
        {
          method: "POST",
          dispatcher: tlsAgent,
          headers: buildHeaders(token),
        },
      );
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }
}

// ------------------------------------------------------------------ helpers

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

// ------------------------------------------------------------------ singleton

let _instance: ObsidianConnector | null = null;

export function getObsidianConnector(): ObsidianConnector {
  if (!_instance) _instance = new ObsidianConnector();
  return _instance;
}

export function resetObsidianConnector(): void {
  _instance = null;
}

// ------------------------------------------------------------------ convenience re-exports

export { loadTokens as isConnected };

// ------------------------------------------------------------------ HTTP handlers
// Wired in src/server.ts under /connections/obsidian/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/obsidian/connect  { apiKey: "...", baseUrl?: "https://..." }
 * Stores the API key and verifies it by calling GET /vault/.
 */
export async function handleObsidianConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  let baseUrl: string = DEFAULT_BASE_URL;
  try {
    const parsed = JSON.parse(body) as { apiKey?: unknown; baseUrl?: unknown };
    if (typeof parsed.apiKey !== "string" || parsed.apiKey.trim() === "") {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            "apiKey is required. Find it in Obsidian → Local REST API plugin settings.",
        }),
      };
    }
    apiKey = parsed.apiKey.trim();
    if (typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() !== "") {
      baseUrl = parsed.baseUrl.trim();
    }
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await undiciFetch(`${baseUrl}/vault/`, {
      dispatcher: tlsAgent,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            "API key rejected by Obsidian plugin — check the key in plugin settings",
        }),
      };
    }
    const tokens: ObsidianTokens = {
      apiKey,
      baseUrl,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetObsidianConnector();
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        baseUrl,
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
 * POST /connections/obsidian/test
 * Verifies stored API key is still valid.
 */
export async function handleObsidianTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Obsidian not connected" }),
    };
  }
  try {
    const connector = getObsidianConnector();
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
 * DELETE /connections/obsidian
 * Removes stored API key.
 */
export function handleObsidianDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetObsidianConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
