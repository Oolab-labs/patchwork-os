/**
 * Figma connector — read-only access to Figma files, comments, and team
 * projects via the Figma REST API.
 *
 * Auth: Personal Access Token sent as `X-Figma-Token: <token>`.
 *   - Env var: FIGMA_ACCESS_TOKEN
 *   - Stored: getSecretJsonSync("figma") → FigmaTokens
 *
 * Tools: getMe, getFile, getFileNodes, getImageUrls, getFileComments,
 *        listTeamProjects, listProjectFiles
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

export interface FigmaTokens {
  accessToken: string;
  userHandle?: string;
  email?: string;
  connected_at: string;
}

export interface FigmaUser {
  id: string;
  handle: string;
  img_url?: string;
  email?: string;
}

export interface FigmaFile {
  name: string;
  lastModified: string;
  version: string;
  document: unknown;
  components?: Record<string, unknown>;
  styles?: Record<string, unknown>;
  schemaVersion?: number;
  thumbnailUrl?: string;
}

export interface FigmaFileNodes {
  name: string;
  lastModified: string;
  version: string;
  nodes: Record<string, { document: unknown } | null>;
}

export interface FigmaImageResult {
  err: string | null;
  images: Record<string, string | null>;
}

export interface FigmaComment {
  id: string;
  file_key: string;
  message: string;
  user: { id: string; handle: string };
  created_at: string;
  resolved_at?: string | null;
}

export interface FigmaCommentsResult {
  comments: FigmaComment[];
}

export interface FigmaProject {
  id: string;
  name: string;
}

export interface FigmaTeamProjectsResult {
  name: string;
  projects: FigmaProject[];
}

export interface FigmaProjectFile {
  key: string;
  name: string;
  thumbnail_url?: string;
  last_modified: string;
}

export interface FigmaProjectFilesResult {
  name: string;
  files: FigmaProjectFile[];
}

export type FigmaImageFormat = "png" | "jpg" | "svg" | "pdf";

const BASE_URL = "https://api.figma.com";
const VALID_IMAGE_FORMATS: ReadonlySet<FigmaImageFormat> = new Set([
  "png",
  "jpg",
  "svg",
  "pdf",
]);

export class FigmaConnector extends BaseConnector {
  readonly providerName = "figma";
  private tokens: FigmaTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Figma not connected. Run: patchwork-os connect figma or set FIGMA_ACCESS_TOKEN",
      );
    }
    this.tokens = tokens;
    return {
      token: tokens.accessToken,
      scopes: ["read"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async () => {
        const res = await fetch(`${BASE_URL}/v1/me`, {
          headers: this.buildHeaders(),
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
      // Figma uses 403 for invalid/expired tokens, not 401.
      if (s === 401 || s === 403)
        return {
          code: "auth_expired",
          message: "Figma authentication expired or invalid — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect figma",
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Figma resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Figma API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      return {
        code: "provider_error",
        message: `Figma API error: HTTP ${s}`,
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
          message: `Cannot connect to Figma: ${error.message}`,
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
      id: "figma",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.userHandle
        ? `Figma user @${tokens.userHandle}`
        : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getMe(): Promise<FigmaUser> {
    const result = await this.apiCall(async () => {
      const res = await fetch(`${BASE_URL}/v1/me`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaUser>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaUser;
  }

  async getFile(
    fileKey: string,
    params: { depth?: number; geometry?: "paths" } = {},
  ): Promise<FigmaFile> {
    if (!fileKey) throw new Error("fileKey is required");
    const depth = params.depth ?? 2;
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      qs.set("depth", String(depth));
      if (params.geometry) qs.set("geometry", params.geometry);
      const res = await fetch(
        `${BASE_URL}/v1/files/${encodeURIComponent(fileKey)}?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaFile>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaFile;
  }

  async getFileNodes(
    fileKey: string,
    nodeIds: string[],
  ): Promise<FigmaFileNodes> {
    if (!fileKey) throw new Error("fileKey is required");
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      throw new Error("nodeIds must be a non-empty array");
    }
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      qs.set("ids", nodeIds.join(","));
      const res = await fetch(
        `${BASE_URL}/v1/files/${encodeURIComponent(fileKey)}/nodes?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaFileNodes>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaFileNodes;
  }

  async getImageUrls(
    fileKey: string,
    params: { ids: string[]; format?: FigmaImageFormat; scale?: number },
  ): Promise<FigmaImageResult> {
    if (!fileKey) throw new Error("fileKey is required");
    if (!params || !Array.isArray(params.ids) || params.ids.length === 0) {
      throw new Error("ids must be a non-empty array");
    }
    const format = params.format ?? "png";
    if (!VALID_IMAGE_FORMATS.has(format)) {
      throw new Error(
        `Invalid format '${format}'. Must be one of: png, jpg, svg, pdf`,
      );
    }
    const scale = params.scale ?? 1;
    const result = await this.apiCall(async () => {
      const qs = new URLSearchParams();
      qs.set("ids", params.ids.join(","));
      qs.set("format", format);
      qs.set("scale", String(scale));
      const res = await fetch(
        `${BASE_URL}/v1/images/${encodeURIComponent(fileKey)}?${qs}`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaImageResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaImageResult;
  }

  async getFileComments(fileKey: string): Promise<FigmaCommentsResult> {
    if (!fileKey) throw new Error("fileKey is required");
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/v1/files/${encodeURIComponent(fileKey)}/comments`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaCommentsResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaCommentsResult;
  }

  async listTeamProjects(teamId: string): Promise<FigmaTeamProjectsResult> {
    if (!teamId) throw new Error("teamId is required");
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/v1/teams/${encodeURIComponent(teamId)}/projects`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaTeamProjectsResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaTeamProjectsResult;
  }

  async listProjectFiles(projectId: string): Promise<FigmaProjectFilesResult> {
    if (!projectId) throw new Error("projectId is required");
    const result = await this.apiCall(async () => {
      const res = await fetch(
        `${BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/files`,
        { headers: this.buildHeaders() },
      );
      if (!res.ok) throw res;
      return res.json() as Promise<FigmaProjectFilesResult>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as FigmaProjectFilesResult;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const token = this.tokens?.accessToken ?? loadTokens()?.accessToken ?? "";
    return {
      "X-Figma-Token": token,
      Accept: "application/json",
    };
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): FigmaTokens | null {
  const envToken = process.env.FIGMA_ACCESS_TOKEN;
  if (envToken) {
    return {
      accessToken: envToken,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<FigmaTokens>("figma");
}

export function saveTokens(tokens: FigmaTokens): void {
  storeSecretJsonSync("figma", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("figma");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: FigmaConnector | null = null;

function resetFigmaConnector(): void {
  _instance = null;
}

export function getFigmaConnector(): FigmaConnector {
  if (!_instance) {
    _instance = new FigmaConnector();
  }
  return _instance;
}

export { getFigmaConnector as figma };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/figma/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/figma/connect  { accessToken }
 */
export async function handleFigmaConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let accessToken: string;

  try {
    const parsed = JSON.parse(body) as { accessToken?: unknown };
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "accessToken is required" }),
      };
    }
    accessToken = parsed.accessToken;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/me`, {
      headers: {
        "X-Figma-Token": accessToken,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Figma (HTTP ${res.status}) — check accessToken`,
        }),
      };
    }
    const user = (await res.json()) as {
      handle?: string;
      email?: string;
    };

    const tokens: FigmaTokens = {
      accessToken,
      userHandle: user.handle,
      email: user.email,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetFigmaConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userHandle: tokens.userHandle,
        email: tokens.email,
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
 * POST /connections/figma/test
 */
export async function handleFigmaTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Figma not connected" }),
    };
  }
  try {
    const connector = getFigmaConnector();
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
 * DELETE /connections/figma
 */
export function handleFigmaDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetFigmaConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
