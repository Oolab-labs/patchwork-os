/**
 * Jira connector — read/write Jira issues via Atlassian REST API v3.
 *
 * Auth: OAuth 2.0 (cloud) or API token + email (server/data center)
 * Tools: fetchIssue, searchIssues, listProjects, createIssue, updateStatus, addComment
 *
 * Extends BaseConnector for unified auth, retry, error handling.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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

/**
 * Accept only https Atlassian-cloud hostnames for the caller-supplied
 * `instanceUrl` handed to `handleJiraConnect`. Without this, an
 * authenticated caller could submit `http://169.254.169.254/...` or
 * `http://127.0.0.1/admin` and the bridge would POST Basic-auth credentials
 * to it. On-prem deployments override via the JIRA_INSTANCE_URL env (which
 * is operator-trusted, not caller-controlled). Mirrors the Confluence guard.
 */
function isAllowedJiraUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    return (
      parsed.hostname === "atlassian.net" ||
      parsed.hostname.endsWith(".atlassian.net")
    );
  } catch {
    return false;
  }
}

export interface JiraTokens {
  accessToken: string; // OAuth or API token
  email?: string; // For server/data center
  instanceUrl: string; // e.g., https://myteam.atlassian.net
  isCloud: boolean;
  connected_at: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string; id: string };
    issuetype: { name: string; id: string };
    priority?: { name: string; id: string };
    assignee?: { displayName: string; emailAddress?: string };
    reporter?: { displayName: string };
    created: string;
    updated: string;
    labels?: string[];
    components?: Array<{ name: string }>;
    fixVersions?: Array<{ name: string }>;
  };
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  avatarUrls?: Record<string, string>;
}

export interface CreateIssueParams {
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string; // default: "Bug"
  priority?: string;
  labels?: string[];
  assignee?: string; // account ID or email
}

const JIRA_CLOUD_API = "/rest/api/3";
const JIRA_SERVER_API = "/rest/api/2";

export class JiraConnector extends BaseConnector {
  readonly providerName = "jira";
  private tokens: JiraTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    // Try loading from file first
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Jira not connected. Run: patchwork-os connect jira or set JIRA_API_TOKEN",
      );
    }

    this.tokens = tokens;

    return {
      token: tokens.accessToken,
      scopes: ["read:jira-work", "write:jira-work"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      // Lightweight check: get my permissions
      const result = await this.apiCall(async (token) => {
        const api = this.getApiPath();
        const url = `${this.tokens?.instanceUrl}${api}/mypermissions`;
        const res = await fetch(url, {
          headers: this.buildHeaders(token),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });

      if ("error" in result) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: this.normalizeError(err),
      };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error instanceof Response) {
      const status = error.status;

      if (status === 401) {
        return {
          code: "auth_expired",
          message: "Jira authentication expired or invalid",
          retryable: false,
          suggestedAction: "Reconnect Jira: patchwork-os connect jira",
        };
      }

      if (status === 403) {
        return {
          code: "permission_denied",
          message: "Insufficient permissions for this Jira operation",
          retryable: false,
          suggestedAction: "Check project permissions in Jira",
        };
      }

      if (status === 404) {
        return {
          code: "not_found",
          message: "Jira issue or project not found",
          retryable: false,
        };
      }

      if (status === 429) {
        return {
          code: "rate_limited",
          message: "Jira API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      }

      return {
        code: "provider_error",
        message: `Jira API error: HTTP ${status}`,
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
          message: `Cannot connect to Jira: ${error.message}`,
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
      id: "jira",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.instanceUrl,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async fetchIssue(issueIdOrKey: string): Promise<JiraIssue | null> {
    const result = await this.apiCall(async (token) => {
      const api = this.getApiPath();
      const url = `${this.tokens?.instanceUrl}${api}/issue/${issueIdOrKey}`;
      const res = await fetch(url, {
        headers: this.buildHeaders(token),
      });

      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });

      if (res.status === 404) return null;
      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    return result.data as JiraIssue;
  }

  async searchIssues(jql: string, maxResults = 50): Promise<JiraSearchResult> {
    const result = await this.apiCall(async (token) => {
      const api = this.getApiPath();
      const params = new URLSearchParams({
        jql,
        maxResults: String(maxResults),
        fields:
          "summary,status,issuetype,priority,assignee,reporter,created,updated,labels",
      });
      const url = `${this.tokens?.instanceUrl}${api}/search?${params}`;
      const res = await fetch(url, {
        headers: this.buildHeaders(token),
      });

      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    return result.data as JiraSearchResult;
  }

  async listProjects(): Promise<JiraProject[]> {
    const result = await this.apiCall(async (token) => {
      const api = this.getApiPath();
      const url = `${this.tokens?.instanceUrl}${api}/project`;
      const res = await fetch(url, {
        headers: this.buildHeaders(token),
      });

      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    return result.data as JiraProject[];
  }

  async createIssue(params: CreateIssueParams): Promise<JiraIssue> {
    const result = await this.apiCall(async (token) => {
      const api = this.getApiPath();
      const url = `${this.tokens?.instanceUrl}${api}/issue`;

      const body: { fields: Record<string, unknown> } = {
        fields: {
          project: { key: params.projectKey },
          summary: params.summary,
          issuetype: { name: params.issueType ?? "Bug" },
        },
      };

      if (params.description) {
        // Atlassian Document Format (ADF) for cloud, plain text for server
        if (this.tokens?.isCloud) {
          body.fields.description = {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: params.description }],
              },
            ],
          };
        } else {
          (body.fields as Record<string, unknown>).description =
            params.description;
        }
      }

      if (params.priority) {
        (body.fields as Record<string, unknown>).priority = {
          name: params.priority,
        };
      }

      if (params.labels) {
        (body.fields as Record<string, unknown>).labels = params.labels;
      }

      if (params.assignee) {
        if (this.tokens?.isCloud) {
          (body.fields as Record<string, unknown>).assignee = {
            accountId: params.assignee,
          };
        } else {
          (body.fields as Record<string, unknown>).assignee = {
            name: params.assignee,
          };
        }
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw res;
      return res.json();
    });

    if ("error" in result) {
      throw new Error(result.error.message);
    }
    return result.data as JiraIssue;
  }

  async updateStatus(
    issueIdOrKey: string,
    transitionId: string,
  ): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const api = this.getApiPath();
      const url = `${this.tokens?.instanceUrl}${api}/issue/${issueIdOrKey}/transitions`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transition: { id: transitionId } }),
      });

      if (!res.ok) throw res;
      return { ok: true };
    });

    if ("error" in result) {
      throw new Error(result.error.message);
    }
  }

  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const api = this.getApiPath();
      const url = `${this.tokens?.instanceUrl}${api}/issue/${issueIdOrKey}/comment`;

      let commentBody: unknown;
      if (this.tokens?.isCloud) {
        commentBody = {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: body }] },
          ],
        };
      } else {
        commentBody = body;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: commentBody }),
      });

      if (!res.ok) throw res;
      return { ok: true };
    });

    if ("error" in result) {
      throw new Error(result.error.message);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getApiPath(): string {
    return this.tokens?.isCloud ? JIRA_CLOUD_API : JIRA_SERVER_API;
  }

  private buildHeaders(token: string): Record<string, string> {
    if (this.tokens?.isCloud) {
      return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
    } else {
      // Server/Data Center uses Basic auth with email:token
      const email = this.tokens?.email ?? "api";
      const basic = Buffer.from(`${email}:${token}`).toString("base64");
      return {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      };
    }
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

/**
 * Cloud-vs-server detection by hostname (not substring match).
 *
 * Substring match like `url.includes("atlassian.net")` is bypassable by a
 * hostile path or subdomain (e.g. `https://atlassian.net.evil.com/...` or
 * `https://evil.com/atlassian.net`) and would route requests as if they were
 * the cloud API.
 */
function isAtlassianCloudHost(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === "atlassian.net" || hostname.endsWith(".atlassian.net");
  } catch {
    return false;
  }
}

function getLegacyTokenPath(): string {
  const patchworkHome =
    process.env.PATCHWORK_HOME ?? path.join(homedir(), ".patchwork");
  return path.join(patchworkHome, "tokens", "jira.json");
}

export function loadTokens(): JiraTokens | null {
  // Environment variable override
  const envToken = process.env.JIRA_API_TOKEN;
  const envUrl = process.env.JIRA_INSTANCE_URL;
  if (envToken && envUrl) {
    return {
      accessToken: envToken,
      instanceUrl: envUrl.replace(/\/$/, ""), // strip trailing slash
      isCloud: isAtlassianCloudHost(envUrl),
      connected_at: new Date().toISOString(),
      email: process.env.JIRA_EMAIL,
    };
  }

  const secure = getSecretJsonSync<JiraTokens>("jira");
  if (secure) {
    return secure;
  }

  const legacyTokenPath = getLegacyTokenPath();
  if (!existsSync(legacyTokenPath)) return null;

  try {
    const data = JSON.parse(
      readFileSync(legacyTokenPath, "utf-8"),
    ) as JiraTokens;
    saveTokens(data);
    return data;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: JiraTokens): void {
  storeSecretJsonSync("jira", tokens);

  const legacyTokenPath = getLegacyTokenPath();
  if (existsSync(legacyTokenPath)) {
    try {
      unlinkSync(legacyTokenPath);
    } catch {}
  }
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("jira");
  } catch {
    // ignore
  }
  const legacyTokenPath = getLegacyTokenPath();
  if (existsSync(legacyTokenPath)) {
    try {
      unlinkSync(legacyTokenPath);
    } catch {}
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: JiraConnector | null = null;

function resetJiraConnector(): void {
  _instance = null;
}

export function getJiraConnector(): JiraConnector {
  if (!_instance) {
    _instance = new JiraConnector();
  }
  return _instance;
}

export { getJiraConnector as jira };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/connectorRoutes.ts under /connections/jira/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/jira/connect  { apiToken, email, instanceUrl }
 *
 * Also accepts legacy `token` field as a synonym for `apiToken` so older
 * dashboard builds keep working.
 */
export async function handleJiraConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiToken: string;
  let email: string;
  let instanceUrl: string;

  try {
    const parsed = JSON.parse(body) as {
      apiToken?: unknown;
      token?: unknown;
      email?: unknown;
      instanceUrl?: unknown;
    };
    const tokenValue =
      typeof parsed.apiToken === "string" && parsed.apiToken
        ? parsed.apiToken
        : typeof parsed.token === "string" && parsed.token
          ? parsed.token
          : "";
    if (!tokenValue) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiToken is required" }),
      };
    }
    if (typeof parsed.email !== "string" || !parsed.email) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "email is required" }),
      };
    }
    if (typeof parsed.instanceUrl !== "string" || !parsed.instanceUrl) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "instanceUrl is required (e.g. https://myteam.atlassian.net)",
        }),
      };
    }
    // SSRF defence — see isAllowedJiraUrl above. On-prem deployments must
    // route through the JIRA_INSTANCE_URL env path, not the dashboard POST.
    if (!isAllowedJiraUrl(parsed.instanceUrl)) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            "instanceUrl must be https and on atlassian.net (e.g. https://myteam.atlassian.net)",
        }),
      };
    }
    apiToken = tokenValue;
    email = parsed.email;
    instanceUrl = parsed.instanceUrl.replace(/\/$/, "");
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  // Verify credentials by hitting /rest/api/3/myself
  try {
    const basic = Buffer.from(`${email}:${apiToken}`).toString("base64");
    const res = await fetch(`${instanceUrl}${JIRA_CLOUD_API}/myself`, {
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Jira (HTTP ${res.status}) — check API token and email`,
        }),
      };
    }

    const tokens: JiraTokens = {
      accessToken: apiToken,
      email,
      instanceUrl,
      isCloud: true,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetJiraConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        instanceUrl,
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
 * POST /connections/jira/test
 *
 * Hits /rest/api/3/myself directly (rather than going through the connector
 * health-check, which checks /mypermissions and requires project scope) so
 * a freshly-issued token with no project access still validates.
 */
export async function handleJiraTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Jira not connected" }),
    };
  }
  try {
    const email = tokens.email ?? "";
    const basic = Buffer.from(`${email}:${tokens.accessToken}`).toString(
      "base64",
    );
    const api = tokens.isCloud ? JIRA_CLOUD_API : JIRA_SERVER_API;
    const res = await fetch(`${tokens.instanceUrl}${api}/myself`, {
      headers: {
        Authorization:
          tokens.isCloud && !tokens.email
            ? `Bearer ${tokens.accessToken}`
            : `Basic ${basic}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Jira rejected credentials (HTTP ${res.status})`,
        }),
      };
    }
    const data = (await res.json()) as {
      accountId?: string;
      emailAddress?: string;
      displayName?: string;
    };
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        user: {
          accountId: data.accountId,
          email: data.emailAddress,
          displayName: data.displayName,
        },
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
 * DELETE /connections/jira
 */
export function handleJiraDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetJiraConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
