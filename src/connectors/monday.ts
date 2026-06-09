/**
 * Monday.com connector — OAuth 2.0 + GraphQL v2.
 *
 * Endpoint: https://api.monday.com/v2 (single GraphQL endpoint).
 * Auth:     OAuth 2.0 via auth.monday.com (MONDAY_CLIENT_ID / MONDAY_CLIENT_SECRET).
 *
 * Mirrors googleDocs.ts shape: secure token storage, OAuth state store,
 * normalizeError categories, refresh-on-401 (Monday tokens do not currently
 * advertise refresh tokens via the published flow — we still wire the path
 * so a future scope addition Just Works).
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { connectorRedirectUri } from "./connectorRedirectUri.js";
import { safeOAuthErrorCode } from "./oauthError.js";
import { createOAuthStateStore } from "./oauthStateStore.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

const SCOPES = [
  "me:read",
  "boards:read",
  "boards:write",
  "updates:read",
  "updates:write",
  "users:read",
  "tags:read",
];
const REDIRECT_URI = connectorRedirectUri("monday");
const MONDAY_AUTH_URL = "https://auth.monday.com/oauth2/authorize";
const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth2/token";
const MONDAY_API = "https://api.monday.com/v2";

function getTokenPath(): string {
  const dir =
    process.env.PATCHWORK_TOKEN_DIR ??
    path.join(homedir(), ".patchwork", "tokens");
  return path.join(dir, "monday.json");
}

export interface MondayTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  name?: string;
  email?: string;
  connected_at: string;
  _client_id?: string;
  _client_secret?: string;
}

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  name?: string;
  email?: string;
}

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
  redirect?: string;
}

// ── Error normalization ──────────────────────────────────────────────────────

export type NormalizedErrorKind =
  | "auth_expired"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "provider_error"
  | "unknown_error";

export interface NormalizedError {
  kind: NormalizedErrorKind;
  status: number;
  message: string;
  retryable: boolean;
}

export function normalizeError(status: number, body: string): NormalizedError {
  if (status === 401) {
    return {
      kind: "auth_expired",
      status,
      message: body || "Authentication expired",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      kind: "permission_denied",
      status,
      message: body || "Permission denied",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: "not_found",
      status,
      message: body || "Resource not found",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      message: body || "Rate limited",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      kind: "provider_error",
      status,
      message: body || "Provider error",
      retryable: true,
    };
  }
  return {
    kind: "unknown_error",
    status,
    message: body || `HTTP ${status}`,
    retryable: false,
  };
}

/**
 * Map a GraphQL error message string to a NormalizedError. Monday returns
 * HTTP 200 on auth failures and embeds the failure as an `errors[]` entry
 * — we need a separate classifier from the HTTP-status one.
 */
export function normalizeGraphQLError(message: string): NormalizedError {
  const m = message || "GraphQL error";
  if (/unauthor/i.test(m) || /invalid token/i.test(m)) {
    return {
      kind: "auth_expired",
      status: 401,
      message: m,
      retryable: false,
    };
  }
  if (/forbid/i.test(m) || /permission/i.test(m)) {
    return {
      kind: "permission_denied",
      status: 403,
      message: m,
      retryable: false,
    };
  }
  if (/rate limit/i.test(m) || /too many/i.test(m)) {
    return { kind: "rate_limited", status: 429, message: m, retryable: true };
  }
  return { kind: "unknown_error", status: 200, message: m, retryable: false };
}

// ── Credentials / storage ────────────────────────────────────────────────────

function clientId(): string {
  return process.env.MONDAY_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.MONDAY_CLIENT_SECRET ?? "";
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

export function loadTokens(): MondayTokens | null {
  const secureTokens = getSecretJsonSync<MondayTokens>("monday");
  if (secureTokens) return secureTokens;

  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const tokens = JSON.parse(readFileSync(tokenPath, "utf-8")) as MondayTokens;
    saveTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: MondayTokens): void {
  storeSecretJsonSync("monday", tokens);
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

function deleteTokens(): void {
  deleteSecretJsonSync("monday");
  const tokenPath = getTokenPath();
  if (existsSync(tokenPath)) {
    try {
      unlinkSync(tokenPath);
    } catch {}
  }
}

export function getStatus(): ConnectorStatus {
  const tokens = loadTokens();
  if (!tokens) return { id: "monday", status: "disconnected" };
  const expired = tokens.expiry_date ? Date.now() > tokens.expiry_date : false;
  const hasCredentials = Boolean(
    (process.env.MONDAY_CLIENT_ID || tokens._client_id) &&
      (process.env.MONDAY_CLIENT_SECRET || tokens._client_secret),
  );
  const canRefresh = Boolean(tokens.refresh_token) && hasCredentials;
  const status = expired && !canRefresh ? "needs_reauth" : "connected";
  return {
    id: "monday",
    status,
    lastSync: tokens.connected_at,
    name: tokens.name,
    email: tokens.email,
  };
}

// ── OAuth ────────────────────────────────────────────────────────────────────

function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return `${MONDAY_AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(
  code: string,
): Promise<Omit<MondayTokens, "connected_at">> {
  const res = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${res.status} (${safeOAuthErrorCode(body)})`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expiry_date: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : undefined,
    token_type: json.token_type,
    scope: json.scope,
    _client_id: clientId() || undefined,
    _client_secret: clientSecret() || undefined,
  };
}

async function refreshAccessToken(tokens: MondayTokens): Promise<MondayTokens> {
  if (!tokens.refresh_token) throw new Error("No refresh token available");
  const id = clientId() || tokens._client_id || "";
  const secret = clientSecret() || tokens._client_secret || "";
  if (!id || !secret)
    throw new Error(
      "Monday client credentials not available — reconnect the Monday connector",
    );
  const res = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed: ${res.status} (${safeOAuthErrorCode(body)})`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
  };
  const updated: MondayTokens = {
    ...tokens,
    access_token: json.access_token,
    expiry_date: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : tokens.expiry_date,
  };
  saveTokens(updated);
  return updated;
}

let refreshInflight: Promise<MondayTokens> | null = null;

export async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Monday not connected");
  const bufferMs = 60_000;
  const needsRefresh =
    Boolean(tokens.expiry_date) &&
    Date.now() > (tokens.expiry_date ?? 0) - bufferMs;
  if (needsRefresh) {
    if (!refreshInflight) {
      refreshInflight = (async () => {
        try {
          return await refreshAccessToken(tokens as MondayTokens);
        } finally {
          refreshInflight = null;
        }
      })();
    }
    tokens = await refreshInflight;
  }
  return tokens.access_token;
}

// ── GraphQL transport ────────────────────────────────────────────────────────

export interface GraphQLError {
  message: string;
  // Monday includes path/locations but we only need message for classification.
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

/**
 * Authenticated GraphQL POST to https://api.monday.com/v2.
 *
 * Monday returns HTTP 200 even when the GraphQL operation failed; the
 * `errors` array must be inspected separately. Auth-shaped errors there
 * are mapped via normalizeGraphQLError so callers see a consistent
 * NormalizedErrorKind.
 *
 * Refresh-on-401 path is wired even though current Monday OAuth flows
 * tend not to issue refresh tokens — when a refresh token IS present
 * (e.g. enterprise / future scope) the retry-once path takes over.
 */
export async function graphqlCall<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<T> {
  const doOnce = async (token: string): Promise<Response> =>
    fetchFn(MONDAY_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

  let token = await getValidAccessToken();
  let res = await doOnce(token);
  if (res.status === 401) {
    const tokens = loadTokens();
    if (tokens?.refresh_token) {
      const refreshed = await refreshAccessToken({ ...tokens, expiry_date: 0 });
      token = refreshed.access_token;
      res = await doOnce(token);
    }
  }
  if (!res.ok) {
    const body = await res.text();
    const norm = normalizeError(res.status, body.slice(0, 200));
    throw new Error(`Monday API error ${norm.status}: ${norm.message}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    const first = json.errors[0] as GraphQLError;
    const norm = normalizeGraphQLError(first.message ?? "");
    throw new Error(`Monday GraphQL error (${norm.kind}): ${norm.message}`);
  }
  return json.data as T;
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface MondayUser {
  id: string;
  name?: string;
  email?: string;
  url?: string;
}

export interface MondayWorkspace {
  id: string;
  name?: string;
}

export interface MondayBoardSummary {
  id: string;
  name: string;
  description?: string;
  state?: string;
  board_kind?: string;
  workspace?: MondayWorkspace | null;
}

export interface MondayColumn {
  id: string;
  title?: string;
  type?: string;
}

export interface MondayGroup {
  id: string;
  title?: string;
}

export interface MondayBoardDetail extends MondayBoardSummary {
  columns?: MondayColumn[];
  groups?: MondayGroup[];
  items_count?: number;
}

export interface MondayColumnValue {
  id: string;
  text?: string | null;
  value?: string | null;
  type?: string;
}

export interface MondayUpdateReply {
  id: string;
  body?: string;
  created_at?: string;
}

export interface MondayUpdate {
  id: string;
  body?: string;
  created_at?: string;
  replies?: MondayUpdateReply[];
}

export interface MondayItemSummary {
  id: string;
  name: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
}

export interface MondayItemDetail extends MondayItemSummary {
  board?: { id: string; name?: string };
  group?: MondayGroup;
  column_values?: MondayColumnValue[];
  subitems?: MondayItemSummary[];
  updates?: MondayUpdate[];
}

export interface MondayItemsPage {
  cursor: string | null;
  items: MondayItemSummary[];
}

// ── Tools (READ-ONLY) ────────────────────────────────────────────────────────

const ME_QUERY = `query Me { me { id name email url } }`;

export async function me(
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayUser> {
  const data = await graphqlCall<{ me: MondayUser }>(
    ME_QUERY,
    undefined,
    fetchFn,
  );
  return data.me;
}

const LIST_BOARDS_QUERY = `query ListBoards($limit: Int!) {
  boards(limit: $limit, order_by: created_at) {
    id name description state board_kind
    workspace { id name }
  }
}`;

export async function listBoards(
  limit = 50,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayBoardSummary[]> {
  const data = await graphqlCall<{ boards: MondayBoardSummary[] }>(
    LIST_BOARDS_QUERY,
    { limit },
    fetchFn,
  );
  return data.boards ?? [];
}

const GET_BOARD_QUERY = `query GetBoard($boardId: ID!) {
  boards(ids: [$boardId]) {
    id name description state board_kind items_count
    workspace { id name }
    columns { id title type }
    groups { id title }
  }
}`;

export async function getBoard(
  boardId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayBoardDetail | null> {
  const data = await graphqlCall<{ boards: MondayBoardDetail[] }>(
    GET_BOARD_QUERY,
    { boardId },
    fetchFn,
  );
  return data.boards?.[0] ?? null;
}

const LIST_ITEMS_QUERY = `query ListItems($boardId: ID!, $limit: Int!, $cursor: String) {
  boards(ids: [$boardId]) {
    items_page(limit: $limit, cursor: $cursor) {
      cursor
      items { id name state created_at updated_at }
    }
  }
}`;

export async function listItems(
  boardId: string,
  limit = 50,
  cursor?: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayItemsPage> {
  const data = await graphqlCall<{
    boards: Array<{ items_page: MondayItemsPage }>;
  }>(LIST_ITEMS_QUERY, { boardId, limit, cursor: cursor ?? null }, fetchFn);
  const page = data.boards?.[0]?.items_page;
  return page ?? { cursor: null, items: [] };
}

const GET_ITEM_QUERY = `query GetItem($itemId: ID!) {
  items(ids: [$itemId]) {
    id name state created_at updated_at
    board { id name }
    group { id title }
    column_values { id text value type }
    subitems { id name state created_at updated_at }
    updates(limit: 25) {
      id body created_at
      replies { id body created_at }
    }
  }
}`;

export async function getItem(
  itemId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayItemDetail | null> {
  const data = await graphqlCall<{ items: MondayItemDetail[] }>(
    GET_ITEM_QUERY,
    { itemId },
    fetchFn,
  );
  return data.items?.[0] ?? null;
}

const GET_UPDATES_QUERY = `query GetUpdates($itemId: ID!, $limit: Int!) {
  items(ids: [$itemId]) {
    updates(limit: $limit) {
      id body created_at
      replies { id body created_at }
    }
  }
}`;

export async function getUpdates(
  itemId: string,
  limit = 25,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayUpdate[]> {
  const data = await graphqlCall<{
    items: Array<{ updates: MondayUpdate[] }>;
  }>(GET_UPDATES_QUERY, { itemId, limit }, fetchFn);
  return data.items?.[0]?.updates ?? [];
}

const SEARCH_BY_NAME_QUERY = `query SearchByName($boardId: ID!, $query: String!) {
  boards(ids: [$boardId]) {
    items_page(
      limit: 50,
      query_params: { rules: [{ column_id: "name", compare_value: [$query], operator: contains_text }] }
    ) {
      cursor
      items { id name state created_at updated_at }
    }
  }
}`;

export async function searchByName(
  boardId: string,
  query: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayItemsPage> {
  const data = await graphqlCall<{
    boards: Array<{ items_page: MondayItemsPage }>;
  }>(SEARCH_BY_NAME_QUERY, { boardId, query }, fetchFn);
  const page = data.boards?.[0]?.items_page;
  return page ?? { cursor: null, items: [] };
}

// ── Write mutations ──────────────────────────────────────────────────────────

export interface MondayCreatedItem {
  id: string;
  name: string;
}

export interface MondayMutationId {
  id: string;
}

export interface MondayCreatedUpdate {
  id: string;
  body: string;
  created_at: string;
}

export interface MondayWebhook {
  id: string;
  board_id: string;
}

export type MondayWebhookEvent =
  | "create_item"
  | "change_column_value"
  | "change_status_column_value"
  | "create_update"
  | "move_item_to_group";

/**
 * Create a new item on a board.
 * `columnValues` is a JSON-encoded string of column values
 * (e.g. `JSON.stringify({ status: { label: "Done" } })`).
 */
export async function createItem(
  boardId: string,
  groupId: string,
  itemName: string,
  columnValues?: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayCreatedItem> {
  const colValPart = columnValues
    ? `, column_values: ${JSON.stringify(columnValues)}`
    : "";
  const query = `mutation {
    create_item(board_id: ${JSON.stringify(boardId)}, group_id: ${JSON.stringify(groupId)}, item_name: ${JSON.stringify(itemName)}${colValPart}) {
      id name
    }
  }`;
  const data = await graphqlCall<{ create_item: MondayCreatedItem }>(
    query,
    undefined,
    fetchFn,
  );
  return data.create_item;
}

/**
 * Update a column value using the JSON-based mutation (complex column types).
 * `value` must be a JSON-encoded string (e.g. `JSON.stringify({ label: "Done" })`).
 */
export async function updateColumnValue(
  boardId: string,
  itemId: string,
  columnId: string,
  value: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayMutationId> {
  const query = `mutation {
    change_column_value(board_id: ${JSON.stringify(boardId)}, item_id: ${JSON.stringify(itemId)}, column_id: ${JSON.stringify(columnId)}, value: ${JSON.stringify(value)}) {
      id
    }
  }`;
  const data = await graphqlCall<{ change_column_value: MondayMutationId }>(
    query,
    undefined,
    fetchFn,
  );
  return data.change_column_value;
}

/**
 * Update a column using simple string/number values
 * (no JSON encoding required for the value itself).
 */
export async function changeItemColumn(
  boardId: string,
  itemId: string,
  columnId: string,
  value: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayMutationId> {
  const query = `mutation {
    change_simple_column_value(board_id: ${JSON.stringify(boardId)}, item_id: ${JSON.stringify(itemId)}, column_id: ${JSON.stringify(columnId)}, value: ${JSON.stringify(value)}) {
      id
    }
  }`;
  const data = await graphqlCall<{
    change_simple_column_value: MondayMutationId;
  }>(query, undefined, fetchFn);
  return data.change_simple_column_value;
}

/** Move an item to a different group on the same board. */
export async function moveItemToGroup(
  itemId: string,
  groupId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayMutationId> {
  const query = `mutation {
    move_item_to_group(item_id: ${JSON.stringify(itemId)}, group_id: ${JSON.stringify(groupId)}) {
      id
    }
  }`;
  const data = await graphqlCall<{ move_item_to_group: MondayMutationId }>(
    query,
    undefined,
    fetchFn,
  );
  return data.move_item_to_group;
}

/** Permanently delete an item. */
export async function deleteItem(
  itemId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayMutationId> {
  const query = `mutation {
    delete_item(item_id: ${JSON.stringify(itemId)}) {
      id
    }
  }`;
  const data = await graphqlCall<{ delete_item: MondayMutationId }>(
    query,
    undefined,
    fetchFn,
  );
  return data.delete_item;
}

/** Post a text update (comment) on an item. */
export async function createUpdate(
  itemId: string,
  body: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayCreatedUpdate> {
  const query = `mutation {
    create_update(item_id: ${JSON.stringify(itemId)}, body: ${JSON.stringify(body)}) {
      id body created_at
    }
  }`;
  const data = await graphqlCall<{ create_update: MondayCreatedUpdate }>(
    query,
    undefined,
    fetchFn,
  );
  return data.create_update;
}

/**
 * Register a Monday.com webhook on a board.
 * `event` must be one of the MondayWebhookEvent values.
 * `columnId` is required for `change_column_value` / `change_status_column_value` events.
 */
export async function createWebhook(
  boardId: string,
  url: string,
  event: MondayWebhookEvent,
  columnId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayWebhook> {
  const configPart = columnId
    ? `, config: ${JSON.stringify(JSON.stringify({ columnId }))}`
    : "";
  const query = `mutation {
    create_webhook(board_id: ${JSON.stringify(boardId)}, url: ${JSON.stringify(url)}, event: ${event}${configPart}) {
      id board_id
    }
  }`;
  const data = await graphqlCall<{ create_webhook: MondayWebhook }>(
    query,
    undefined,
    fetchFn,
  );
  return data.create_webhook;
}

/** Delete a Monday.com webhook by its ID. */
export async function deleteWebhook(
  webhookId: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MondayMutationId> {
  const query = `mutation {
    delete_webhook(id: ${JSON.stringify(webhookId)}) {
      id
    }
  }`;
  const data = await graphqlCall<{ delete_webhook: MondayMutationId }>(
    query,
    undefined,
    fetchFn,
  );
  return data.delete_webhook;
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify an incoming Monday.com webhook request.
 *
 * Monday sends the signing secret directly in the `Authorization` header
 * (no "Bearer" prefix). Compare with constant-time equality to prevent
 * timing attacks.
 *
 * @param rawBody          - Raw request body string (before JSON.parse).
 * @param authorizationHeader - Value of the `Authorization` header from the
 *                           incoming request (may be undefined/null).
 * @param signingSecret    - The webhook signing secret configured on Monday.
 * @returns true when the header matches the secret.
 */
export function verifyMondayWebhook(
  _rawBody: string,
  authorizationHeader: string | null | undefined,
  signingSecret: string,
): boolean {
  if (!authorizationHeader) return false;
  const a = Buffer.from(authorizationHeader);
  const b = Buffer.from(signingSecret);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

const pendingStates = createOAuthStateStore({ namespace: "monday" });

function generateState(): string {
  const state = crypto.randomBytes(32).toString("hex");
  if (!pendingStates.add(state)) {
    throw new Error(
      "OAuth state store full — too many concurrent authorize requests",
    );
  }
  return state;
}

export function handleMondayAuthRedirect(): ConnectorHandlerResult {
  if (!isConfigured()) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "MONDAY_CLIENT_ID and MONDAY_CLIENT_SECRET env vars not set",
      }),
    };
  }
  const state = generateState();
  return { status: 302, body: "", redirect: buildAuthUrl(state) };
}

export async function handleMondayCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<ConnectorHandlerResult> {
  if (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error }),
    };
  }
  if (!code || !state || !pendingStates.consume(state)) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid OAuth state" }),
    };
  }
  try {
    const oauthTokens = await exchangeCode(code);
    let profile: { name?: string; email?: string } = {};
    try {
      // best-effort: capture user identity via the `me` query
      const res = await fetch(MONDAY_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oauthTokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: ME_QUERY }),
      });
      if (res.ok) {
        const json = (await res.json()) as GraphQLResponse<{ me: MondayUser }>;
        if (!json.errors && json.data?.me) {
          profile = { name: json.data.me.name, email: json.data.me.email };
        }
      }
    } catch {
      // profile capture is best-effort
    }
    const tokens: MondayTokens = {
      ...oauthTokens,
      ...profile,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        name: profile.name,
        email: profile.email,
      }),
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

/**
 * Health check: POST `{ me { id name email } }` and verify the response
 * contains a non-empty `data.me` envelope.
 */
export async function handleMondayTest(): Promise<ConnectorHandlerResult> {
  try {
    const user = await me();
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        id: user.id,
        name: user.name,
        email: user.email,
      }),
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

export async function handleMondayDisconnect(): Promise<ConnectorHandlerResult> {
  // Monday OAuth has no public revoke endpoint — drop the local token only.
  deleteTokens();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
