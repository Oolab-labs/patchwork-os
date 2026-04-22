/**
 * Jira connector — read/write Jira issues via Atlassian REST API v3.
 *
 * Auth: OAuth 2.0 (cloud) or API token + email (server/data center)
 * Tools: fetchIssue, searchIssues, listProjects, createIssue, updateStatus, addComment
 *
 * Extends BaseConnector for unified auth, retry, error handling.
 */

import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";

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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TOKEN_PATH = path.join(homedir(), ".patchwork", "tokens", "jira.json");

export function loadTokens(): JiraTokens | null {
  // Environment variable override
  const envToken = process.env.JIRA_API_TOKEN;
  const envUrl = process.env.JIRA_INSTANCE_URL;
  if (envToken && envUrl) {
    return {
      accessToken: envToken,
      instanceUrl: envUrl.replace(/\/$/, ""), // strip trailing slash
      isCloud: envUrl.includes("atlassian.net"),
      connected_at: new Date().toISOString(),
      email: process.env.JIRA_EMAIL,
    };
  }

  if (!existsSync(TOKEN_PATH)) return null;

  try {
    const data = JSON.parse(readFileSync(TOKEN_PATH, "utf-8")) as JiraTokens;
    return data;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: JiraTokens): void {
  const dir = path.dirname(TOKEN_PATH);
  if (!existsSync(dir)) {
    import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: JiraConnector | null = null;

export function getJiraConnector(): JiraConnector {
  if (!_instance) {
    _instance = new JiraConnector();
  }
  return _instance;
}

export { getJiraConnector as jira };
