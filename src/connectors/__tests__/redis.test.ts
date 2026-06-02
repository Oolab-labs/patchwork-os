import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setRedisModuleForTest,
  handleRedisConnect,
  handleRedisDisconnect,
  handleRedisTest,
  isReadOnlyCommand,
  loadTokens,
  parseInfo,
  READ_ONLY_COMMANDS,
  type RedisClientLike,
  RedisConnector,
  type RedisModuleLike,
  redactUrl,
  resetRedisConnector,
  saveTokens,
} from "../redis.js";

// ---------------------------------------------------------------- fake client

interface FakeClientOptions {
  pingReply?: string | (() => string | Promise<string>);
  connectError?: Error;
  scanPages?: Array<{ cursor: number | string; keys: string[] }>;
  typeMap?: Record<string, string>;
  getMap?: Record<string, string | null>;
  hgetallMap?: Record<string, Record<string, string>>;
  lrangeMap?: Record<string, string[]>;
  smembersMap?: Record<string, string[]>;
  zrangeWithScoresMap?: Record<string, Array<{ value: string; score: number }>>;
  ttlMap?: Record<string, number>;
  infoReply?: string;
  dbSizeReply?: number;
  sendCommandImpl?: (args: string[]) => Promise<unknown>;
  pingError?: Error;
}

function makeFakeClient(opts: FakeClientOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let scanIdx = 0;
  const client: RedisClientLike = {
    connect: vi.fn(async () => {
      if (opts.connectError) throw opts.connectError;
    }),
    quit: vi.fn(async () => undefined),
    ping: vi.fn(async () => {
      calls.push({ method: "ping", args: [] });
      if (opts.pingError) throw opts.pingError;
      const r = opts.pingReply ?? "PONG";
      return typeof r === "function" ? await r() : r;
    }),
    info: vi.fn(async (section?: string) => {
      calls.push({ method: "info", args: [section] });
      return opts.infoReply ?? "# Server\nredis_version:7.0.0\n";
    }),
    dbSize: vi.fn(async () => {
      calls.push({ method: "dbSize", args: [] });
      return opts.dbSizeReply ?? 0;
    }),
    type: vi.fn(async (key: string) => {
      calls.push({ method: "type", args: [key] });
      return opts.typeMap?.[key] ?? "none";
    }),
    get: vi.fn(async (key: string) => {
      calls.push({ method: "get", args: [key] });
      return opts.getMap?.[key] ?? null;
    }),
    hGetAll: vi.fn(async (key: string) => {
      calls.push({ method: "hGetAll", args: [key] });
      return opts.hgetallMap?.[key] ?? {};
    }),
    lRange: vi.fn(async (key: string, start: number, stop: number) => {
      calls.push({ method: "lRange", args: [key, start, stop] });
      return opts.lrangeMap?.[key] ?? [];
    }),
    sMembers: vi.fn(async (key: string) => {
      calls.push({ method: "sMembers", args: [key] });
      return opts.smembersMap?.[key] ?? [];
    }),
    zRangeWithScores: vi.fn(
      async (key: string, start: number, stop: number) => {
        calls.push({ method: "zRangeWithScores", args: [key, start, stop] });
        return opts.zrangeWithScoresMap?.[key] ?? [];
      },
    ),
    zRange: vi.fn(async (key: string, start: number, stop: number) => {
      calls.push({ method: "zRange", args: [key, start, stop] });
      return [];
    }),
    ttl: vi.fn(async (key: string) => {
      calls.push({ method: "ttl", args: [key] });
      return opts.ttlMap?.[key] ?? -2;
    }),
    scan: vi.fn(async (cursor, scanOpts) => {
      calls.push({ method: "scan", args: [cursor, scanOpts] });
      const pages = opts.scanPages ?? [{ cursor: 0, keys: [] }];
      const page = pages[Math.min(scanIdx, pages.length - 1)]!;
      scanIdx++;
      return page;
    }),
    sendCommand: vi.fn(async (args: string[]) => {
      calls.push({ method: "sendCommand", args: [args] });
      if (opts.sendCommandImpl) return opts.sendCommandImpl(args);
      return "OK";
    }),
    on: vi.fn((_event: string, _l: (...a: unknown[]) => void) => client),
  };
  return { client, calls };
}

function makeFakeModule(client: RedisClientLike): RedisModuleLike {
  return {
    createClient: vi.fn(() => client),
  };
}

// ---------------------------------------------------------------- env / fs scaffolding

const tmpDir = join(os.tmpdir(), `patchwork-redis-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  mkdirSync(tokensDir, { recursive: true });
});

afterEach(async () => {
  __setRedisModuleForTest(null);
  await resetRedisConnector();
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

function seed() {
  saveTokens({
    url: "redis://localhost:6379",
    connected_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------- tests

describe("redis allowlist", () => {
  it("accepts every documented read-only command", () => {
    for (const cmd of READ_ONLY_COMMANDS) {
      const [head, ...rest] = cmd.split(" ");
      expect(isReadOnlyCommand(head!, rest)).toBe(true);
    }
  });

  it("is case-insensitive on the first token", () => {
    expect(isReadOnlyCommand("get")).toBe(true);
    expect(isReadOnlyCommand("GeT")).toBe(true);
    expect(isReadOnlyCommand("HGETALL")).toBe(true);
  });

  it("rejects every write/dangerous command", () => {
    for (const c of [
      "SET",
      "DEL",
      "FLUSHDB",
      "FLUSHALL",
      "CONFIG",
      "SCRIPT",
      "EVAL",
      "EVALSHA",
      "RENAME",
      "EXPIRE",
      "HSET",
      "LPUSH",
      "SADD",
      "ZADD",
      "SHUTDOWN",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  it("rejects empty / non-string commands", () => {
    expect(isReadOnlyCommand("")).toBe(false);
    // @ts-expect-error intentional bad input
    expect(isReadOnlyCommand(undefined)).toBe(false);
  });

  it("handles two-word commands like DEBUG OBJECT", () => {
    expect(isReadOnlyCommand("DEBUG", ["OBJECT", "key"])).toBe(true);
    // DEBUG alone (without OBJECT subcommand) is not in the set
    expect(isReadOnlyCommand("DEBUG")).toBe(false);
  });

  // Regression: bare "CLIENT"/"MEMORY" were in the allowlist, so mutating
  // subcommands (CLIENT KILL/SETNAME/NO-EVICT/UNPAUSE, MEMORY PURGE) all
  // passed as "read-only". Only the safe two-word forms should be allowed.
  it("rejects bare CLIENT (no read-only subcommand)", () => {
    expect(isReadOnlyCommand("CLIENT")).toBe(false);
  });

  it("rejects bare MEMORY (no read-only subcommand)", () => {
    expect(isReadOnlyCommand("MEMORY")).toBe(false);
  });

  it("rejects mutating CLIENT subcommands", () => {
    expect(isReadOnlyCommand("CLIENT", ["KILL", "ID", "5"])).toBe(false);
    expect(isReadOnlyCommand("CLIENT", ["SETNAME", "x"])).toBe(false);
    expect(isReadOnlyCommand("CLIENT", ["NO-EVICT", "ON"])).toBe(false);
    expect(isReadOnlyCommand("CLIENT", ["UNPAUSE"])).toBe(false);
  });

  it("rejects MEMORY PURGE", () => {
    expect(isReadOnlyCommand("MEMORY", ["PURGE"])).toBe(false);
  });

  it("still allows safe CLIENT subcommands", () => {
    expect(isReadOnlyCommand("CLIENT", ["GETNAME"])).toBe(true);
    expect(isReadOnlyCommand("CLIENT", ["ID"])).toBe(true);
    expect(isReadOnlyCommand("CLIENT", ["INFO"])).toBe(true);
    expect(isReadOnlyCommand("CLIENT", ["LIST"])).toBe(true);
  });

  it("still allows safe MEMORY subcommands", () => {
    expect(isReadOnlyCommand("MEMORY", ["USAGE", "key"])).toBe(true);
    expect(isReadOnlyCommand("MEMORY", ["STATS"])).toBe(true);
    expect(isReadOnlyCommand("MEMORY", ["DOCTOR"])).toBe(true);
  });
});

describe("RedisConnector.command_run", () => {
  it("rejects SET via command_run before reaching the wire", async () => {
    seed();
    const { client } = makeFakeClient();
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    await expect(conn.command_run("SET", ["k", "v"])).rejects.toThrow(
      /not in the read-only allowlist/i,
    );
    expect(client.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    "DEL",
    "FLUSHDB",
    "CONFIG",
    "SCRIPT",
    "EVAL",
  ])("rejects %s", async (cmd) => {
    seed();
    const { client } = makeFakeClient();
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    await expect(conn.command_run(cmd, [])).rejects.toThrow(/allowlist/i);
  });

  it("permits allowlisted commands and forwards args", async () => {
    seed();
    const { client, calls } = makeFakeClient({
      sendCommandImpl: async () => "pong-ish",
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const out = await conn.command_run("PING", []);
    expect(out).toBe("pong-ish");
    const lastSend = calls.find((c) => c.method === "sendCommand");
    expect(lastSend?.args[0]).toEqual(["PING"]);
  });

  it("rejects CLIENT KILL / MEMORY PURGE before reaching the wire", async () => {
    seed();
    const { client } = makeFakeClient();
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    await expect(
      conn.command_run("CLIENT", ["KILL", "ID", "5"]),
    ).rejects.toThrow(/not in the read-only allowlist/i);
    await expect(conn.command_run("MEMORY", ["PURGE"])).rejects.toThrow(
      /not in the read-only allowlist/i,
    );
    expect(client.sendCommand).not.toHaveBeenCalled();
  });

  it("allows CLIENT LIST / MEMORY USAGE through command_run", async () => {
    seed();
    const { client, calls } = makeFakeClient({
      sendCommandImpl: async (args) => args.join(" "),
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    expect(await conn.command_run("CLIENT", ["LIST"])).toBe("CLIENT LIST");
    expect(await conn.command_run("MEMORY", ["USAGE", "k"])).toBe(
      "MEMORY USAGE k",
    );
    expect(calls.filter((c) => c.method === "sendCommand")).toHaveLength(2);
  });
});

describe("RedisConnector.keys uses SCAN, never KEYS", () => {
  it("walks SCAN pages and stops at cursor 0", async () => {
    seed();
    const { client, calls } = makeFakeClient({
      scanPages: [
        { cursor: 7, keys: ["a", "b"] },
        { cursor: 0, keys: ["c"] },
      ],
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const keys = await conn.keys("*");
    expect(keys).toEqual(["a", "b", "c"]);
    // never KEYS — that method shouldn't even exist on our client.
    // Just confirm scan was used at least twice.
    const scanCount = calls.filter((c) => c.method === "scan").length;
    expect(scanCount).toBeGreaterThanOrEqual(2);
  });

  it("honours the limit and stops scanning early", async () => {
    seed();
    const { client, calls } = makeFakeClient({
      scanPages: [
        { cursor: 1, keys: ["a", "b", "c"] },
        { cursor: 2, keys: ["d", "e"] },
        { cursor: 0, keys: ["f"] },
      ],
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const keys = await conn.keys("*", 2);
    expect(keys).toEqual(["a", "b"]);
    // Should have stopped after the first page once the cap was hit.
    expect(calls.filter((c) => c.method === "scan").length).toBe(1);
  });

  it("rejects empty patterns", async () => {
    seed();
    const { client } = makeFakeClient();
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    await expect(conn.keys("")).rejects.toThrow(/non-empty/i);
  });
});

describe("RedisConnector.normalizeError", () => {
  it("maps WRONGPASS to auth_expired", () => {
    const conn = new RedisConnector();
    const err = conn.normalizeError(
      new Error("WRONGPASS invalid username-password pair"),
    );
    expect(err.code).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("maps NOAUTH to auth_expired", () => {
    const conn = new RedisConnector();
    expect(
      conn.normalizeError(new Error("NOAUTH Authentication required")).code,
    ).toBe("auth_expired");
  });

  it("maps NOPERM to permission_denied", () => {
    const conn = new RedisConnector();
    expect(
      conn.normalizeError(new Error("NOPERM this user has no permissions"))
        .code,
    ).toBe("permission_denied");
  });

  it("maps ECONNREFUSED to retryable network_error", () => {
    const conn = new RedisConnector();
    const err = conn.normalizeError(
      new Error("connect ECONNREFUSED 127.0.0.1:6379"),
    );
    expect(err.code).toBe("network_error");
    expect(err.retryable).toBe(true);
  });

  it("maps ETIMEDOUT to retryable network_error", () => {
    const conn = new RedisConnector();
    expect(conn.normalizeError(new Error("connect ETIMEDOUT")).retryable).toBe(
      true,
    );
  });

  it("defaults to provider_error", () => {
    const conn = new RedisConnector();
    expect(conn.normalizeError(new Error("kaboom")).code).toBe(
      "provider_error",
    );
  });
});

describe("RedisConnector.connect validates by ping", () => {
  it("healthCheck returns ok:true when PING replies PONG", async () => {
    seed();
    const { client } = makeFakeClient({ pingReply: "PONG" });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const r = await conn.healthCheck();
    expect(r.ok).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it("healthCheck returns ok:false when PING throws WRONGPASS", async () => {
    seed();
    const { client } = makeFakeClient({
      pingError: new Error("WRONGPASS bad password"),
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const r = await conn.healthCheck();
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("auth_expired");
  });

  it("healthCheck returns ok:false for non-PONG reply", async () => {
    seed();
    const { client } = makeFakeClient({ pingReply: "weird" });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const r = await conn.healthCheck();
    expect(r.ok).toBe(false);
  });
});

describe("RedisConnector read ops", () => {
  it("info() parses the INFO reply into key/value pairs", async () => {
    seed();
    const { client } = makeFakeClient({
      infoReply:
        "# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:42\r\n# Clients\r\nconnected_clients:3\r\n",
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const out = await conn.info("server");
    expect(out.redis_version).toBe("7.2.4");
    expect(out.connected_clients).toBe("3");
  });

  it("get() refuses non-string keys (no WRONGTYPE escape)", async () => {
    seed();
    const { client } = makeFakeClient({ typeMap: { mylist: "list" } });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    await expect(conn.get("mylist")).rejects.toThrow(/WRONGTYPE/i);
  });

  it("get() returns the string for string-typed keys", async () => {
    seed();
    const { client } = makeFakeClient({
      typeMap: { mykey: "string" },
      getMap: { mykey: "hello" },
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    expect(await conn.get("mykey")).toBe("hello");
  });

  it("smembers caps the result to the requested limit", async () => {
    seed();
    const { client } = makeFakeClient({
      smembersMap: { s: ["a", "b", "c", "d", "e"] },
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    expect(await conn.smembers("s", 2)).toEqual(["a", "b"]);
  });

  it("zrange with scores returns score-tagged pairs", async () => {
    seed();
    const { client } = makeFakeClient({
      zrangeWithScoresMap: { z: [{ value: "x", score: 1 }] },
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const conn = new RedisConnector();
    const out = await conn.zrange("z", 0, -1, true);
    expect(out).toEqual([{ value: "x", score: 1 }]);
  });
});

describe("parseInfo", () => {
  it("skips comment lines and blanks", () => {
    expect(parseInfo("# Section\nfoo:bar\n\nbaz:qux\n")).toEqual({
      foo: "bar",
      baz: "qux",
    });
  });
});

describe("redactUrl", () => {
  it("hides the password component", () => {
    expect(redactUrl("redis://user:hunter2@host:6379/0")).toContain("***");
    expect(redactUrl("redis://user:hunter2@host:6379/0")).not.toContain(
      "hunter2",
    );
  });

  it("returns the input unchanged on parse failure", () => {
    expect(redactUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("token helpers", () => {
  it("loadTokens returns null when no file exists", () => {
    expect(loadTokens()).toBeNull();
  });

  it("saveTokens + loadTokens round-trips", () => {
    saveTokens({
      url: "redis://h:6379",
      database: 2,
      connected_at: "2026-01-01T00:00:00.000Z",
    });
    const t = loadTokens();
    expect(t).toMatchObject({ url: "redis://h:6379", database: 2 });
  });
});

describe("handleRedisConnect", () => {
  it("rejects invalid JSON", async () => {
    const r = await handleRedisConnect("{not json");
    expect(r.status).toBe(400);
  });

  it("rejects missing url", async () => {
    const r = await handleRedisConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
  });

  it("rejects non-redis schemes", async () => {
    const r = await handleRedisConnect(
      JSON.stringify({ url: "http://localhost:6379" }),
    );
    expect(r.status).toBe(400);
  });

  it("stores tokens on a successful PING", async () => {
    const { client } = makeFakeClient({ pingReply: "PONG" });
    __setRedisModuleForTest(makeFakeModule(client));
    const r = await handleRedisConnect(
      JSON.stringify({ url: "redis://localhost:6379" }),
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(loadTokens()?.url).toBe("redis://localhost:6379");
  });

  it("returns 401 on WRONGPASS", async () => {
    const { client } = makeFakeClient({
      pingError: new Error("WRONGPASS invalid"),
    });
    __setRedisModuleForTest(makeFakeModule(client));
    const r = await handleRedisConnect(
      JSON.stringify({ url: "redis://localhost:6379", password: "x" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

describe("handleRedisTest / handleRedisDisconnect", () => {
  it("test returns 400 when no tokens stored", async () => {
    const r = await handleRedisTest();
    expect(r.status).toBe(400);
  });

  it("disconnect clears stored tokens", async () => {
    seed();
    expect(loadTokens()).not.toBeNull();
    const r = await handleRedisDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});
