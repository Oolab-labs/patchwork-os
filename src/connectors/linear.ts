/**
 * Linear connector.
 *
 * Uses Linear's GraphQL API with a personal API key (no OAuth app required).
 * Token stored at ~/.patchwork/tokens/linear.json (mode 0600).
 * Env var: LINEAR_API_KEY
 *
 * HTTP routes registered in server.ts:
 *   POST   /connections/linear/connect   — store token + verify
 *   POST   /connections/linear/test      — verify stored token works
 *   DELETE /connections/linear           — delete stored token
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LINEAR_API = "https://api.linear.app/graphql";
const TOKEN_PATH = path.join(homedir(), ".patchwork", "tokens", "linear.json");

export interface LinearTokens {
  api_key: string;
  workspace?: string;
  connected_at: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
  workspace?: string;
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function loadTokens(): LinearTokens | null {
  const envKey = process.env.LINEAR_API_KEY;
  if (envKey) {
    return { api_key: envKey, connected_at: new Date().toISOString() };
  }
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf-8")) as LinearTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: LinearTokens): void {
  mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function deleteTokens(): void {
  if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  return {
    id: "linear",
    status: tokens ? "connected" : "disconnected",
    lastSync: tokens?.connected_at,
    workspace: tokens?.workspace,
  };
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

export async function linearQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(
      `Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }
  return json.data as T;
}

const VIEWER_QUERY = `query { viewer { id name email organization { name urlKey } } }`;

async function verifyToken(
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ name: string; email: string; workspace: string }> {
  const data = await linearQuery<{
    viewer: {
      name: string;
      email: string;
      organization: { name: string; urlKey: string };
    };
  }>(VIEWER_QUERY, {}, apiKey, signal);
  return {
    name: data.viewer.name,
    email: data.viewer.email,
    workspace: data.viewer.organization.urlKey,
  };
}

// ── Issue fetching ────────────────────────────────────────────────────────────

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: { name: string; type: string };
  assignee?: { name: string; email: string };
  priority: number;
  priorityLabel: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  team: { name: string; key: string };
  labels: { nodes: Array<{ name: string }> };
}

const ISSUE_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      state { name type }
      assignee { name email }
      priority
      priorityLabel
      url
      createdAt
      updatedAt
      team { name key }
      labels { nodes { name } }
    }
  }
`;

/**
 * Fetch a Linear issue by ID or URL.
 * Accepts: "LIN-123", "abc123def456...", "https://linear.app/.../issue/LIN-123/..."
 */
export async function fetchIssue(
  issueIdOrUrl: string,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "Linear not connected. POST /connections/linear/connect first.",
    );
  }

  const id = extractIssueId(issueIdOrUrl);
  const data = await linearQuery<{ issue: LinearIssue }>(
    ISSUE_QUERY,
    { id },
    tokens.api_key,
    signal,
  );
  if (!data.issue) {
    throw new Error(`Linear issue not found: ${id}`);
  }
  return data.issue;
}

function extractIssueId(issueIdOrUrl: string): string {
  // URL form: https://linear.app/org/issue/LIN-123/title
  const urlMatch = issueIdOrUrl.match(/\/issue\/([A-Z]+-\d+|[a-f0-9-]{36})/i);
  if (urlMatch) return urlMatch[1] as string;
  // Identifier form: LIN-123, TEAM-456
  if (/^[A-Z]+-\d+$/i.test(issueIdOrUrl.trim())) return issueIdOrUrl.trim();
  // UUID form
  if (/^[a-f0-9-]{36}$/i.test(issueIdOrUrl.trim())) return issueIdOrUrl.trim();
  throw new Error(`Cannot parse Linear issue ID from: ${issueIdOrUrl}`);
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

export async function handleLinearConnect(
  body: unknown,
): Promise<ConnectorHandlerResult> {
  const { api_key } = (body ?? {}) as { api_key?: string };
  if (!api_key || typeof api_key !== "string") {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "api_key required" }),
    };
  }
  try {
    const { name, email, workspace } = await verifyToken(api_key);
    const tokens: LinearTokens = {
      api_key,
      workspace,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, name, email, workspace }),
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export async function handleLinearTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Linear not connected" }),
    };
  }
  try {
    const { name, email } = await verifyToken(tokens.api_key);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, name, email }),
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export function handleLinearDisconnect(): ConnectorHandlerResult {
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
