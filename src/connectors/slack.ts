/**
 * Slack connector — calls Slack Web API directly with bot token.
 *
 * OAuth 2.0 (not PKCE) — Slack uses its own flow with bot token in response.
 * Tokens stored at ~/.patchwork/tokens/slack.json (mode 0600).
 * Client credentials: PATCHWORK_SLACK_CLIENT_ID / PATCHWORK_SLACK_CLIENT_SECRET
 *
 * HTTP routes (wired in src/server.ts):
 *   GET    /connections/slack/authorize — redirect to Slack consent
 *   GET    /connections/slack/callback  — exchange code for bot token
 *   POST   /connections/slack/test      — ping Slack API
 *   DELETE /connections/slack           — delete stored token
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
import { escHtml } from "./htmlEscape.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const SLACK_AUTH_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SCOPES = [
  "chat:write",
  "channels:read",
  "channels:history",
  "users:read",
].join(",");

function getPatchworkTokensDir(): string {
  const patchworkHome =
    process.env.PATCHWORK_HOME ?? path.join(homedir(), ".patchwork");
  return path.join(patchworkHome, "tokens");
}

function getLegacyTokenPath(): string {
  return path.join(getPatchworkTokensDir(), "slack.json");
}

function getStatePath(): string {
  return path.join(getPatchworkTokensDir(), "slack-state.json");
}

export interface SlackTokenFile {
  access_token: string; // bot token (xoxb-...)
  team_id: string;
  team_name: string;
  bot_user_id: string;
  connected_at: string;
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

function clientId(): string {
  return process.env.PATCHWORK_SLACK_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.PATCHWORK_SLACK_CLIENT_SECRET ?? "";
}

function redirectUri(): string {
  const base = (
    process.env.PATCHWORK_BRIDGE_URL ??
    `http://localhost:${process.env.PATCHWORK_BRIDGE_PORT ?? "3101"}`
  ).replace(/\/$/, "");
  return `${base}/connections/slack/callback`;
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function loadTokens(): SlackTokenFile | null {
  const secureTokens = getSecretJsonSync<SlackTokenFile>("slack");
  if (secureTokens) {
    return secureTokens;
  }

  const legacyTokenPath = getLegacyTokenPath();
  if (!existsSync(legacyTokenPath)) return null;
  try {
    const tokens = JSON.parse(
      readFileSync(legacyTokenPath, "utf-8"),
    ) as SlackTokenFile;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(file: SlackTokenFile): void {
  storeSecretJsonSync("slack", file);

  const legacyTokenPath = getLegacyTokenPath();
  if (existsSync(legacyTokenPath)) {
    try {
      unlinkSync(legacyTokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("slack");
  const legacyTokenPath = getLegacyTokenPath();
  if (existsSync(legacyTokenPath)) {
    try {
      unlinkSync(legacyTokenPath);
    } catch {}
  }
  const statePath = getStatePath();
  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
    } catch {}
  }
}

export function isConnected(): boolean {
  return loadTokens() !== null;
}

// ── State (CSRF) ──────────────────────────────────────────────────────────────

function saveState(state: string): void {
  const statePath = getStatePath();
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify({ state, ts: Date.now() }), {
    mode: 0o600,
  });
}

function consumeState(): string | null {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return null;
  try {
    const { state, ts } = JSON.parse(readFileSync(statePath, "utf-8")) as {
      state: string;
      ts: number;
    };
    unlinkSync(statePath);
    if (Date.now() - ts > 10 * 60 * 1000) return null; // 10-min TTL
    return state;
  } catch {
    return null;
  }
}

// ── API helper ────────────────────────────────────────────────────────────────

async function slackGet(
  method: string,
  params: Record<string, string>,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`Slack API ${method} HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!json.ok)
    throw new Error(`Slack API ${method} error: ${json.error ?? "unknown"}`);
  return json;
}

async function slackPost(
  method: string,
  body: Record<string, unknown>,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Slack API ${method} HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!json.ok)
    throw new Error(`Slack API ${method} error: ${json.error ?? "unknown"}`);
  return json;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function postMessage(
  channel: string,
  text: string,
  threadTs?: string,
  blocks?: unknown[],
  signal?: AbortSignal,
): Promise<{ ts: string; channel: string }> {
  const tokens = loadTokens();
  if (!tokens)
    throw new Error(
      "Slack not connected. GET /connections/slack/authorize first.",
    );
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks?.length) body.blocks = blocks;
  const res = await slackPost(
    "chat.postMessage",
    body,
    tokens.access_token,
    signal,
  );
  return {
    ts: (res.ts as string) ?? "",
    channel: (res.channel as string) ?? channel,
  };
}

export interface SlackChannel {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
  numMembers?: number;
}

export async function listChannels(
  limit = 100,
  signal?: AbortSignal,
): Promise<SlackChannel[]> {
  const tokens = loadTokens();
  if (!tokens)
    throw new Error(
      "Slack not connected. GET /connections/slack/authorize first.",
    );
  const res = await slackGet(
    "conversations.list",
    {
      types: "public_channel",
      exclude_archived: "true",
      limit: String(Math.min(limit, 200)),
    },
    tokens.access_token,
    signal,
  );
  const channels = (res.channels as Array<Record<string, unknown>>) ?? [];
  return channels.map((c) => ({
    id: (c.id as string) ?? "",
    name: (c.name as string) ?? "",
    isMember: Boolean(c.is_member),
    isPrivate: Boolean(c.is_private),
    numMembers: typeof c.num_members === "number" ? c.num_members : undefined,
  }));
}

export interface SlackProfile {
  teamId: string;
  teamName: string;
  botUserId: string;
}

export function getProfile(): SlackProfile | null {
  const tokens = loadTokens();
  if (!tokens) return null;
  return {
    teamId: tokens.team_id,
    teamName: tokens.team_name,
    botUserId: tokens.bot_user_id,
  };
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

export function handleSlackAuthorize(): ConnectorHandlerResult {
  if (!clientId()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "PATCHWORK_SLACK_CLIENT_ID not set — create a Slack app first",
      }),
    };
  }
  const state = crypto.randomBytes(16).toString("hex");
  saveState(state);
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return { status: 302, body: "", redirect: `${SLACK_AUTH_URL}?${params}` };
}

export async function handleSlackCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Slack connect failed</h2><pre>${escHtml(error)}</pre></body></html>`,
    };
  }
  if (!code || !state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Slack connect failed</h2><pre>missing code or state</pre></body></html>`,
    };
  }
  const savedState = consumeState();
  if (!savedState || savedState !== state) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Slack connect failed</h2><pre>invalid state</pre></body></html>`,
    };
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
    });
    const res = await fetch(SLACK_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Token exchange HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    if (!json.ok)
      throw new Error(`Token exchange error: ${json.error ?? "unknown"}`);

    const botToken = (json.access_token as string) ?? "";
    const team = (json.team as Record<string, unknown>) ?? {};
    const botUser = (json.bot_user_id as string) ?? "";

    saveTokens({
      access_token: botToken,
      team_id: (team.id as string) ?? "",
      team_name: (team.name as string) ?? "",
      bot_user_id: botUser,
      connected_at: new Date().toISOString(),
    });

    return {
      status: 200,
      contentType: "text/html",
      body: `<html><body><h2>Slack connected to ${escHtml((team.name as string) ?? "workspace")}</h2><script>try { window.opener.postMessage('patchwork:slack:connected', '*'); } catch(_) {} window.close();</script></body></html>`,
    };
  } catch (err) {
    return {
      status: 400,
      contentType: "text/html",
      body: `<html><body><h2>Slack connect failed</h2><pre>${escHtml(err instanceof Error ? err.message : String(err))}</pre></body></html>`,
    };
  }
}

export async function handleSlackTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "Not connected" }),
    };
  }
  try {
    await slackGet("auth.test", {}, tokens.access_token);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        message: `Connected to ${tokens.team_name}`,
      }),
    };
  } catch (err) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export function handleSlackDisconnect(): ConnectorHandlerResult {
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
