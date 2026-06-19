/**
 * Redis connector — read-only operations against a Redis server.
 *
 * Auth: connection URL (redis:// or rediss://) optionally with password.
 *   - Stored: getSecretJsonSync("redis") → RedisTokens
 *
 * Tools (READ-ONLY only — no SET/DEL/FLUSHDB/CONFIG mutators):
 *   info, dbsize, keys (SCAN-based), type, get, hgetall, lrange,
 *   smembers, zrange, ttl, command_run (allowlist-gated)
 *
 * Driver loaded lazily via `await import("redis")` (node-redis v4+).
 * Hermetic tests inject a fake module via `__setRedisModuleForTest`.
 *
 * Extends BaseConnector for unified status, error normalization,
 * token persistence. apiCall is unused because Redis is not HTTP —
 * errors flow through normalizeError directly.
 */

import { isPrivateHost } from "../ssrfGuard.js";
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

// ------------------------------------------------------------------ types

export interface RedisTokens {
  url: string;
  username?: string;
  password?: string;
  database?: number;
  tls?: boolean;
  connected_at: string;
}

/** Minimal subset of the node-redis v4 client surface we exercise. */
export interface RedisClientLike {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  ping(): Promise<string>;
  info(section?: string): Promise<string>;
  dbSize(): Promise<number>;
  type(key: string): Promise<string>;
  get(key: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  sMembers(key: string): Promise<string[]>;
  zRangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ value: string; score: number }>>;
  zRange(key: string, start: number, stop: number): Promise<string[]>;
  ttl(key: string): Promise<number>;
  scan(
    cursor: number | string,
    opts?: { MATCH?: string; COUNT?: number },
  ): Promise<{ cursor: number | string; keys: string[] }>;
  sendCommand(args: string[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface RedisModuleLike {
  createClient(opts: {
    url: string;
    username?: string;
    password?: string;
    database?: number;
  }): RedisClientLike;
}

// ------------------------------------------------------------------ lazy driver

let _injectedModule: RedisModuleLike | null = null;

/** Test-only: inject a fake `redis` module so tests run hermetically. */
export function __setRedisModuleForTest(mod: RedisModuleLike | null): void {
  _injectedModule = mod;
}

async function loadRedisModule(): Promise<RedisModuleLike> {
  if (_injectedModule) return _injectedModule;
  try {
    // The `redis` package is an optional peer — typecheck environments may
    // not have it installed. The runtime guard below catches the missing
    // module and tells the operator to install it.
    // @ts-expect-error optional peer; resolved at runtime
    const mod = (await import("redis")) as unknown as RedisModuleLike;
    if (!mod || typeof mod.createClient !== "function") {
      throw new Error("redis module missing createClient export");
    }
    return mod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Redis driver not installed (${msg}). Run: npm install redis`,
    );
  }
}

// ------------------------------------------------------------------ read-only allowlist

/**
 * Commands the connector permits. First token is matched case-insensitively.
 * Multi-word commands (e.g. "DEBUG OBJECT") match against the first token
 * AND the joined first-two-token form so callers can issue either shape.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "GET",
  "MGET",
  "EXISTS",
  "TYPE",
  "TTL",
  "PTTL",
  "HGET",
  "HGETALL",
  "HMGET",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HEXISTS",
  "LRANGE",
  "LLEN",
  "LINDEX",
  "SMEMBERS",
  "SCARD",
  "SISMEMBER",
  "ZRANGE",
  "ZREVRANGE",
  "ZSCORE",
  "ZCARD",
  "ZRANGEBYSCORE",
  "SCAN",
  "HSCAN",
  "SSCAN",
  "ZSCAN",
  "DBSIZE",
  "INFO",
  "PING",
  // CLIENT / MEMORY are containers for both read-only AND mutating
  // subcommands (CLIENT KILL/SETNAME/NO-EVICT/UNPAUSE, MEMORY PURGE).
  // Allowlist only the safe two-word forms — never the bare command.
  "CLIENT GETNAME",
  "CLIENT ID",
  "CLIENT INFO",
  "CLIENT LIST",
  "MEMORY USAGE",
  "MEMORY STATS",
  "MEMORY DOCTOR",
  "DEBUG OBJECT",
]);

export function isReadOnlyCommand(cmd: string, args: string[] = []): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const head = cmd.trim().toUpperCase();
  if (READ_ONLY_COMMANDS.has(head)) return true;
  // Two-word form (e.g. "DEBUG OBJECT")
  if (args.length > 0 && typeof args[0] === "string") {
    const joined = `${head} ${args[0]!.toUpperCase()}`;
    if (READ_ONLY_COMMANDS.has(joined)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): RedisTokens | null {
  return getSecretJsonSync<RedisTokens>("redis");
}

export function saveTokens(tokens: RedisTokens): void {
  storeSecretJsonSync("redis", tokens);
}

export function clearTokens(): void {
  deleteSecretJsonSync("redis");
}

// ------------------------------------------------------------------ INFO parsing

export function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ connector

export class RedisConnector extends BaseConnector {
  readonly providerName = "redis";
  protected cachedTokens: RedisTokens | null = null;
  private client: RedisClientLike | null = null;
  private connectInflight: Promise<RedisClientLike> | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Redis not connected. Run: patchwork connect redis  (provide URL)",
      );
    }
    this.cachedTokens = tokens;
    // Redis isn't a bearer-token API; the auth context is informational.
    return { token: tokens.password ?? "" };
  }

  /** Get (or lazily create + connect) the singleton client. */
  async getClient(): Promise<RedisClientLike> {
    if (this.client) return this.client;
    if (this.connectInflight) return this.connectInflight;
    const tokens = this.cachedTokens ?? loadTokens();
    if (!tokens) {
      throw new Error(
        "Redis not connected. Run: patchwork connect redis  (provide URL)",
      );
    }
    this.cachedTokens = tokens;
    this.connectInflight = (async () => {
      const mod = await loadRedisModule();
      const client = mod.createClient({
        url: tokens.url,
        username: tokens.username,
        password: tokens.password,
        database: tokens.database,
      });
      // Swallow background error events so an idle connection drop doesn't
      // bubble up as an unhandled error; commands surface their own errors.
      try {
        client.on("error", () => {});
      } catch {
        /* some fakes don't implement .on */
      }
      await client.connect();
      this.client = client;
      this.connectInflight = null;
      return client;
    })();
    return this.connectInflight;
  }

  /** Tear down the client (used by disconnect HTTP handler + tests). */
  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.quit();
    } catch {
      /* ignore quit errors */
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const c = await this.getClient();
      const pong = await c.ping();
      if (typeof pong === "string" && pong.toUpperCase() === "PONG") {
        return { ok: true };
      }
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: `Unexpected PING reply: ${String(pong)}`,
          retryable: false,
        },
      };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    const msg =
      error instanceof Error ? error.message : String(error ?? "unknown");
    if (/WRONGPASS|NOAUTH/i.test(msg)) {
      return {
        code: "auth_expired",
        message: "Redis authentication failed",
        retryable: false,
        suggestedAction: "Reconnect: patchwork connect redis",
      };
    }
    if (/NOPERM/i.test(msg)) {
      return {
        code: "permission_denied",
        message: "Redis user lacks permission for this command",
        retryable: false,
      };
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
      return {
        code: "network_error",
        message: `Cannot reach Redis server: ${msg}`,
        retryable: true,
      };
    }
    return {
      code: "provider_error",
      message: msg,
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "redis",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens ? redactUrl(tokens.url) : undefined,
    };
  }

  // ---------------------------------------------------------------- read ops

  async info(section?: string): Promise<Record<string, string>> {
    const c = await this.getClient();
    try {
      const raw = section ? await c.info(section) : await c.info();
      return parseInfo(raw);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async dbsize(): Promise<number> {
    const c = await this.getClient();
    try {
      return await c.dbSize();
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  /**
   * SCAN-based key iteration. Never uses `KEYS *` because that blocks the
   * server. Stops once `limit` keys are gathered OR the cursor wraps to 0.
   */
  async keys(pattern: string, limit = 100): Promise<string[]> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("pattern must be a non-empty string");
    }
    const cap = Math.max(1, Math.min(limit, 10_000));
    const c = await this.getClient();
    const collected: string[] = [];
    let cursor: number | string = 0;
    try {
      // Guard against pathological servers that never wrap by capping iterations.
      for (let i = 0; i < 1000; i++) {
        const res = await c.scan(cursor, { MATCH: pattern, COUNT: 100 });
        if (Array.isArray(res.keys)) {
          for (const k of res.keys) {
            collected.push(k);
            if (collected.length >= cap) return collected;
          }
        }
        cursor = res.cursor;
        // node-redis returns cursor 0 (number or string) when iteration done.
        if (cursor === 0 || cursor === "0") break;
      }
      return collected;
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async type(key: string): Promise<string> {
    const c = await this.getClient();
    try {
      return await c.type(key);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async get(key: string): Promise<string | null> {
    const c = await this.getClient();
    try {
      const t = await c.type(key);
      if (t !== "string" && t !== "none") {
        throw new Error(
          `WRONGTYPE: GET only supports string keys (key is ${t})`,
        );
      }
      return await c.get(key);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const c = await this.getClient();
    try {
      return await c.hGetAll(key);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async lrange(key: string, start = 0, stop = 99): Promise<string[]> {
    const c = await this.getClient();
    try {
      return await c.lRange(key, start, stop);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async smembers(key: string, limit = 100): Promise<string[]> {
    const c = await this.getClient();
    try {
      const all = await c.sMembers(key);
      const cap = Math.max(1, Math.min(limit, 10_000));
      return all.slice(0, cap);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async zrange(
    key: string,
    start = 0,
    stop = 99,
    withScores = true,
  ): Promise<Array<{ value: string; score: number }> | string[]> {
    const c = await this.getClient();
    try {
      if (withScores) return await c.zRangeWithScores(key, start, stop);
      return await c.zRange(key, start, stop);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  async ttl(key: string): Promise<number> {
    const c = await this.getClient();
    try {
      return await c.ttl(key);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }

  /**
   * Generic escape hatch. The command MUST appear in the read-only allowlist.
   * Anything else is rejected before it ever touches the wire.
   */
  async command_run(cmd: string, args: string[] = []): Promise<unknown> {
    if (!isReadOnlyCommand(cmd, args)) {
      const err: ConnectorError = {
        code: "permission_denied",
        message: `Command "${cmd}" is not in the read-only allowlist`,
        retryable: false,
        suggestedAction:
          "Patchwork Redis connector is read-only; use a separate tool for mutations.",
      };
      throw new Error(err.message);
    }
    if (!Array.isArray(args)) {
      throw new Error("args must be an array of strings");
    }
    for (const a of args) {
      if (typeof a !== "string") {
        throw new Error("all args must be strings");
      }
    }
    const c = await this.getClient();
    try {
      return await c.sendCommand([cmd, ...args]);
    } catch (err) {
      throw new Error(this.normalizeError(err).message);
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Hide the password from any redis:// URL before logging or display. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

// ------------------------------------------------------------------ singleton

let _instance: RedisConnector | null = null;

export function getRedisConnector(): RedisConnector {
  if (!_instance) _instance = new RedisConnector();
  return _instance;
}

export async function resetRedisConnector(): Promise<void> {
  if (_instance) {
    try {
      await _instance.disconnect();
    } catch {
      /* ignore */
    }
  }
  _instance = null;
}

export { loadTokens as isConnected };

// ------------------------------------------------------------------ HTTP handlers

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

function jsonRes(status: number, body: unknown): ConnectorHandlerResult {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/**
 * POST /connections/redis/connect
 *   { url: "redis://...", username?, password?, database?, tls? }
 *
 * Verifies the URL by opening a transient client and PINGing. Stores tokens
 * on success.
 */
export async function handleRedisConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let parsed: {
    url?: unknown;
    username?: unknown;
    password?: unknown;
    database?: unknown;
    tls?: unknown;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonRes(400, { ok: false, error: "Invalid JSON body" });
  }

  if (typeof parsed.url !== "string" || parsed.url.length === 0) {
    return jsonRes(400, {
      ok: false,
      error: 'Missing "url" (e.g. redis://localhost:6379 or rediss://...)',
    });
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsed.url);
  } catch {
    return jsonRes(400, { ok: false, error: "Malformed Redis URL" });
  }
  if (parsedUrl.protocol !== "redis:" && parsedUrl.protocol !== "rediss:") {
    return jsonRes(400, {
      ok: false,
      error: 'URL must use the "redis://" or "rediss://" scheme',
    });
  }
  // SSRF guard: block non-loopback private/reserved hosts (H1, audit 2026-06-19).
  {
    const h = parsedUrl.hostname.toLowerCase();
    const isLoopback =
      h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h);
    if (!isLoopback && isPrivateHost(parsedUrl.hostname)) {
      return jsonRes(400, {
        ok: false,
        error: "Private or reserved hostname not allowed",
      });
    }
  }

  const tokens: RedisTokens = {
    url: parsed.url,
    username: typeof parsed.username === "string" ? parsed.username : undefined,
    password: typeof parsed.password === "string" ? parsed.password : undefined,
    database:
      typeof parsed.database === "number" && Number.isInteger(parsed.database)
        ? parsed.database
        : undefined,
    tls: parsed.tls === true || parsedUrl.protocol === "rediss:",
    connected_at: new Date().toISOString(),
  };

  let mod: RedisModuleLike;
  try {
    mod = await loadRedisModule();
  } catch (err) {
    return jsonRes(500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const client = mod.createClient({
    url: tokens.url,
    username: tokens.username,
    password: tokens.password,
    database: tokens.database,
  });
  try {
    try {
      client.on("error", () => {});
    } catch {
      /* fakes may lack .on */
    }
    await client.connect();
    const pong = await client.ping();
    if (typeof pong !== "string" || pong.toUpperCase() !== "PONG") {
      return jsonRes(401, {
        ok: false,
        error: `Unexpected PING reply: ${String(pong)}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /WRONGPASS|NOAUTH/i.test(msg) ? 401 : 502;
    try {
      await client.quit();
    } catch {
      /* ignore */
    }
    return jsonRes(status, { ok: false, error: msg });
  }
  try {
    await client.quit();
  } catch {
    /* ignore */
  }

  saveTokens(tokens);
  await resetRedisConnector();
  return jsonRes(200, {
    ok: true,
    workspace: redactUrl(tokens.url),
    connectedAt: tokens.connected_at,
  });
}

/**
 * POST /connections/redis/test — verify stored connection still works.
 */
export async function handleRedisTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return jsonRes(400, { ok: false, error: "Redis not connected" });
  }
  try {
    const connector = getRedisConnector();
    const check = await connector.healthCheck();
    return jsonRes(check.ok ? 200 : 401, {
      ok: check.ok,
      ...(check.ok ? {} : { error: check.error?.message }),
    });
  } catch (err) {
    return jsonRes(500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * DELETE /connections/redis — remove stored tokens and tear down the client.
 */
export async function handleRedisDisconnect(): Promise<ConnectorHandlerResult> {
  clearTokens();
  await resetRedisConnector();
  return jsonRes(200, { ok: true });
}
