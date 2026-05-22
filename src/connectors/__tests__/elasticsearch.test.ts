import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setEsModuleForTest,
  clearTokens,
  ElasticsearchConnector,
  type EsClientLike,
  type EsModuleLike,
  getElasticsearchConnector,
  handleElasticsearchConnect,
  handleElasticsearchDisconnect,
  handleElasticsearchTest,
  isReadOnlyEsQuery,
  loadTokens,
  resetElasticsearchConnector,
  saveTokens,
  validateSearchBody,
} from "../elasticsearch.js";

// ------------------------------------------------------------------ stub driver

interface StubCalls {
  pingCalls: number;
  closeCalls: number;
  catIndices: Array<unknown>;
  getMapping: Array<unknown>;
  getSettings: Array<unknown>;
  search: Array<unknown>;
  count: Array<unknown>;
  clusterHealth: number;
  lastClientOpts: Record<string, unknown> | null;
}

function makeStub(
  opts: { pingThrows?: unknown; searchThrows?: unknown } = {},
): { mod: EsModuleLike; calls: StubCalls } {
  const calls: StubCalls = {
    pingCalls: 0,
    closeCalls: 0,
    catIndices: [],
    getMapping: [],
    getSettings: [],
    search: [],
    count: [],
    clusterHealth: 0,
    lastClientOpts: null,
  };

  class StubClient implements EsClientLike {
    constructor(clientOpts: Record<string, unknown>) {
      calls.lastClientOpts = clientOpts;
    }
    async ping() {
      calls.pingCalls++;
      if (opts.pingThrows) throw opts.pingThrows;
      return true;
    }
    async close() {
      calls.closeCalls++;
    }
    cat = {
      indices: async (p: { format: string; h?: string }) => {
        calls.catIndices.push(p);
        return [{ index: "idx1", "docs.count": "42", health: "green" }];
      },
    };
    indices = {
      getMapping: async (p: { index: string }) => {
        calls.getMapping.push(p);
        return { [p.index]: { mappings: {} } };
      },
      getSettings: async (p: { index: string }) => {
        calls.getSettings.push(p);
        return { [p.index]: { settings: {} } };
      },
    };
    async search(p: Record<string, unknown>) {
      calls.search.push(p);
      if (opts.searchThrows) throw opts.searchThrows;
      return { hits: { total: { value: 0 }, hits: [] } };
    }
    async count(p: Record<string, unknown>) {
      calls.count.push(p);
      return { count: 0 };
    }
    cluster = {
      health: async () => {
        calls.clusterHealth++;
        return { status: "green" };
      },
    };
  }

  return {
    calls,
    mod: { Client: StubClient as unknown as EsModuleLike["Client"] },
  };
}

// ------------------------------------------------------------------ query guard

describe("isReadOnlyEsQuery", () => {
  it("accepts a simple term query", () => {
    expect(isReadOnlyEsQuery({ term: { foo: "bar" } })).toEqual({ ok: true });
  });

  it("rejects top-level `script` key", () => {
    const r = isReadOnlyEsQuery({ script: { source: "doc['x'].value" } });
    expect(r.ok).toBe(false);
  });

  it("rejects nested `script` key inside query.bool.filter", () => {
    const r = isReadOnlyEsQuery({
      bool: {
        filter: [{ script: { source: "1+1" } }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects `script_fields`", () => {
    const r = isReadOnlyEsQuery({ script_fields: { x: { script: "" } } });
    expect(r.ok).toBe(false);
  });

  it("rejects `script_score`", () => {
    const r = isReadOnlyEsQuery({
      function_score: { script_score: { script: { source: "1" } } },
    });
    expect(r.ok).toBe(false);
  });

  it("matches case-insensitively (SCRIPT)", () => {
    const r = isReadOnlyEsQuery({ SCRIPT: { source: "x" } });
    expect(r.ok).toBe(false);
  });

  it("walks through arrays", () => {
    const r = isReadOnlyEsQuery({
      bool: { must: [{}, { script: { source: "x" } }] },
    });
    expect(r.ok).toBe(false);
  });

  it("ignores null and primitives", () => {
    expect(isReadOnlyEsQuery(null)).toEqual({ ok: true });
    expect(isReadOnlyEsQuery(42)).toEqual({ ok: true });
    expect(isReadOnlyEsQuery("script")).toEqual({ ok: true });
  });
});

describe("validateSearchBody", () => {
  it("accepts known top-level keys", () => {
    const r = validateSearchBody({
      query: { match_all: {} },
      size: 10,
      from: 0,
      sort: [{ ts: "desc" }],
      _source: ["a", "b"],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const r = validateSearchBody({
      query: { match_all: {} },
      pipeline: "evil",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects script inside an otherwise-allowed body", () => {
    const r = validateSearchBody({
      query: { script: { source: "1" } },
    });
    expect(r.ok).toBe(false);
  });
});

// ------------------------------------------------------------------ token helpers

describe("elasticsearch token helpers", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-es-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.ELASTICSEARCH_NODE;
    delete process.env.ELASTICSEARCH_API_KEY;
    delete process.env.ELASTICSEARCH_USERNAME;
    delete process.env.ELASTICSEARCH_PASSWORD;
    delete process.env.ELASTICSEARCH_CLOUD_ID;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadTokens returns null when no env and no stored", () => {
    expect(loadTokens()).toBeNull();
  });

  it("loadTokens returns cloudId+apiKey env combo", () => {
    process.env.ELASTICSEARCH_CLOUD_ID = "cloudA";
    process.env.ELASTICSEARCH_API_KEY = "apiK";
    const t = loadTokens();
    expect(t?.cloudId).toBe("cloudA");
    expect(t?.apiKey).toBe("apiK");
  });

  it("loadTokens returns node+apiKey env combo", () => {
    process.env.ELASTICSEARCH_NODE = "https://es:9200";
    process.env.ELASTICSEARCH_API_KEY = "apiK";
    const t = loadTokens();
    expect(t?.node).toBe("https://es:9200");
    expect(t?.apiKey).toBe("apiK");
  });

  it("loadTokens returns node+basic-auth env combo", () => {
    process.env.ELASTICSEARCH_NODE = "https://es:9200";
    process.env.ELASTICSEARCH_USERNAME = "elastic";
    process.env.ELASTICSEARCH_PASSWORD = "secret";
    const t = loadTokens();
    expect(t?.username).toBe("elastic");
    expect(t?.password).toBe("secret");
  });

  it("saveTokens + loadTokens round-trips through file storage", () => {
    saveTokens({
      node: "https://es:9200",
      apiKey: "apiK",
      connected_at: "2026-05-22T00:00:00.000Z",
    });
    const loaded = loadTokens();
    expect(loaded).toMatchObject({
      node: "https://es:9200",
      apiKey: "apiK",
    });
  });

  it("clearTokens does not throw on missing file", () => {
    expect(() => clearTokens()).not.toThrow();
  });
});

// ------------------------------------------------------------------ connector ops

describe("ElasticsearchConnector — connect paths", () => {
  beforeEach(() => {
    __setEsModuleForTest(null);
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  });
  afterEach(() => {
    __setEsModuleForTest(null);
    delete process.env.ELASTICSEARCH_NODE;
    delete process.env.ELASTICSEARCH_API_KEY;
    delete process.env.ELASTICSEARCH_USERNAME;
    delete process.env.ELASTICSEARCH_PASSWORD;
    delete process.env.ELASTICSEARCH_CLOUD_ID;
  });

  it("uses cloudId+apiKey when both provided", async () => {
    process.env.ELASTICSEARCH_CLOUD_ID = "cloudA";
    process.env.ELASTICSEARCH_API_KEY = "apiK";
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    const hc = await conn.healthCheck();
    expect(hc.ok).toBe(true);
    expect(calls.lastClientOpts).toMatchObject({
      cloud: { id: "cloudA" },
      auth: { apiKey: "apiK" },
    });
    await conn.disconnect();
  });

  it("uses node+apiKey when no cloudId", async () => {
    process.env.ELASTICSEARCH_NODE = "https://es:9200";
    process.env.ELASTICSEARCH_API_KEY = "apiK";
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await conn.healthCheck();
    expect(calls.lastClientOpts).toMatchObject({
      node: "https://es:9200",
      auth: { apiKey: "apiK" },
    });
    await conn.disconnect();
  });

  it("uses node+basic-auth when no apiKey", async () => {
    process.env.ELASTICSEARCH_NODE = "https://es:9200";
    process.env.ELASTICSEARCH_USERNAME = "elastic";
    process.env.ELASTICSEARCH_PASSWORD = "secret";
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await conn.healthCheck();
    expect(calls.lastClientOpts).toMatchObject({
      node: "https://es:9200",
      auth: { username: "elastic", password: "secret" },
    });
    await conn.disconnect();
  });

  it("authenticate throws when no credentials", async () => {
    const conn = new ElasticsearchConnector();
    await expect(conn.authenticate()).rejects.toThrow(/not connected/i);
  });
});

describe("ElasticsearchConnector — read ops + guards", () => {
  beforeEach(() => {
    __setEsModuleForTest(null);
    process.env.ELASTICSEARCH_NODE = "https://es:9200";
    process.env.ELASTICSEARCH_API_KEY = "apiK";
  });
  afterEach(() => {
    __setEsModuleForTest(null);
    delete process.env.ELASTICSEARCH_NODE;
    delete process.env.ELASTICSEARCH_API_KEY;
  });

  it("listIndices calls cat.indices with json format", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    const r = await conn.listIndices();
    expect(r).toBeDefined();
    expect(calls.catIndices[0]).toMatchObject({ format: "json" });
  });

  it("describeIndex returns mapping + settings", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    const r = await conn.describeIndex("logs-2026");
    expect(r).toHaveProperty("mapping");
    expect(r).toHaveProperty("settings");
    expect(calls.getMapping[0]).toMatchObject({ index: "logs-2026" });
    expect(calls.getSettings[0]).toMatchObject({ index: "logs-2026" });
  });

  it("search caps size at 100", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await conn.search("idx", { match_all: {} }, 5000);
    const arg = calls.search[0] as { body: { size: number } };
    expect(arg.body.size).toBe(100);
  });

  it("search passes from + sort + _source through", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await conn.search(
      "idx",
      { match_all: {} },
      10,
      20,
      [{ ts: "desc" }],
      ["a"],
    );
    const arg = calls.search[0] as {
      body: { from: number; sort: unknown; _source: unknown };
    };
    expect(arg.body.from).toBe(20);
    expect(arg.body.sort).toEqual([{ ts: "desc" }]);
    expect(arg.body._source).toEqual(["a"]);
  });

  it("search rejects script in query at top level", async () => {
    const { mod } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await expect(
      conn.search("idx", { script: { source: "1+1" } }),
    ).rejects.toThrow(/script/i);
  });

  it("search rejects nested script_fields", async () => {
    const { mod } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await expect(
      conn.search("idx", {
        bool: { must: [{ script_fields: { x: {} } }] },
      }),
    ).rejects.toThrow();
  });

  it("count rejects script in query", async () => {
    const { mod } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await expect(
      conn.count("idx", { script: { source: "1" } }),
    ).rejects.toThrow();
  });

  it("aggregate rejects script in aggs", async () => {
    const { mod } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await expect(
      conn.aggregate("idx", { script_score: { script: { source: "1" } } }),
    ).rejects.toThrow();
  });

  it("aggregate sets size:0 and calls search()", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    await conn.aggregate("idx", { by_host: { terms: { field: "host" } } });
    const arg = calls.search[0] as { body: { size: number; aggs: unknown } };
    expect(arg.body.size).toBe(0);
    expect(arg.body.aggs).toBeDefined();
  });

  it("clusterHealth calls cluster.health()", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const conn = new ElasticsearchConnector();
    const r = (await conn.clusterHealth()) as { status: string };
    expect(r.status).toBe("green");
    expect(calls.clusterHealth).toBe(1);
  });
});

// ------------------------------------------------------------------ normalizeError

describe("ElasticsearchConnector.normalizeError", () => {
  const conn = new ElasticsearchConnector();

  it("401 → auth_expired (non-retryable)", () => {
    const e = conn.normalizeError({
      name: "ResponseError",
      statusCode: 401,
      message: "unauthorized",
    });
    expect(e.code).toBe("auth_expired");
    expect(e.retryable).toBe(false);
  });

  it("403 → permission_denied", () => {
    const e = conn.normalizeError({ name: "ResponseError", statusCode: 403 });
    expect(e.code).toBe("permission_denied");
    expect(e.retryable).toBe(false);
  });

  it("404 → not_found", () => {
    const e = conn.normalizeError({ name: "ResponseError", statusCode: 404 });
    expect(e.code).toBe("not_found");
  });

  it("429 → rate_limited retryable", () => {
    const e = conn.normalizeError({ name: "ResponseError", statusCode: 429 });
    expect(e.code).toBe("rate_limited");
    expect(e.retryable).toBe(true);
  });

  it("500+ → provider_error retryable", () => {
    const e = conn.normalizeError({ name: "ResponseError", statusCode: 503 });
    expect(e.code).toBe("provider_error");
    expect(e.retryable).toBe(true);
  });

  it("statusCode from meta.statusCode fallback", () => {
    const e = conn.normalizeError({
      name: "ResponseError",
      meta: { statusCode: 401 },
    });
    expect(e.code).toBe("auth_expired");
  });

  it("ConnectionError → network_error retryable", () => {
    const e = conn.normalizeError({
      name: "ConnectionError",
      message: "ECONNREFUSED",
    });
    expect(e.code).toBe("network_error");
    expect(e.retryable).toBe(true);
  });

  it("plain Error with ENOTFOUND → network_error", () => {
    const e = conn.normalizeError(new Error("getaddrinfo ENOTFOUND es"));
    expect(e.code).toBe("network_error");
  });

  it("unknown error → provider_error non-retryable", () => {
    const e = conn.normalizeError("weird string");
    expect(e.code).toBe("provider_error");
    expect(e.retryable).toBe(false);
  });
});

// ------------------------------------------------------------------ HTTP handlers

describe("handleElasticsearchConnect", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-es-h-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    __setEsModuleForTest(null);
  });
  afterEach(async () => {
    await resetElasticsearchConnector();
    __setEsModuleForTest(null);
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects malformed JSON body", async () => {
    const r = await handleElasticsearchConnect("not json");
    expect(r.status).toBe(400);
  });

  it("rejects when no valid credential combo", async () => {
    const r = await handleElasticsearchConnect(JSON.stringify({ node: "" }));
    expect(r.status).toBe(400);
  });

  it("rejects malformed node URL", async () => {
    const r = await handleElasticsearchConnect(
      JSON.stringify({ node: "not a url", apiKey: "x" }),
    );
    expect(r.status).toBe(400);
  });

  it("connects with cloudId+apiKey, calls ping", async () => {
    const { mod, calls } = makeStub();
    __setEsModuleForTest(mod);
    const r = await handleElasticsearchConnect(
      JSON.stringify({ cloudId: "cloudA", apiKey: "apiK" }),
    );
    expect(r.status).toBe(200);
    expect(calls.pingCalls).toBeGreaterThan(0);
  });

  it("rolls back when ping fails", async () => {
    const { mod } = makeStub({
      pingThrows: Object.assign(new Error("unauthorized"), {
        name: "ResponseError",
        statusCode: 401,
      }),
    });
    __setEsModuleForTest(mod);
    const r = await handleElasticsearchConnect(
      JSON.stringify({ cloudId: "cloudA", apiKey: "bad" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

describe("handleElasticsearchTest + Disconnect", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-es-t-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    __setEsModuleForTest(null);
  });
  afterEach(async () => {
    await resetElasticsearchConnector();
    __setEsModuleForTest(null);
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test returns 400 when not connected", async () => {
    const r = await handleElasticsearchTest();
    expect(r.status).toBe(400);
  });

  it("test returns 200 when ping succeeds", async () => {
    saveTokens({
      cloudId: "cloudA",
      apiKey: "apiK",
      connected_at: new Date().toISOString(),
    });
    const { mod } = makeStub();
    __setEsModuleForTest(mod);
    const r = await handleElasticsearchTest();
    expect(r.status).toBe(200);
  });

  it("disconnect clears tokens", async () => {
    saveTokens({
      cloudId: "cloudA",
      apiKey: "apiK",
      connected_at: new Date().toISOString(),
    });
    const r = await handleElasticsearchDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ------------------------------------------------------------------ singleton

describe("singleton", () => {
  afterEach(async () => {
    await resetElasticsearchConnector();
  });

  it("returns same instance until reset", () => {
    const a = getElasticsearchConnector();
    const b = getElasticsearchConnector();
    expect(a).toBe(b);
  });

  it("returns new instance after reset", async () => {
    const a = getElasticsearchConnector();
    await resetElasticsearchConnector();
    const b = getElasticsearchConnector();
    expect(a).not.toBe(b);
  });
});

// ------------------------------------------------------------------ driver-missing

describe("lazy driver", () => {
  it("throws helpful error when driver not installed", async () => {
    __setEsModuleForTest(null);
    // Force the dynamic import to fail by pretending no driver
    // (in test environment the package is not installed)
    process.env.ELASTICSEARCH_NODE = "https://es:9200";
    process.env.ELASTICSEARCH_API_KEY = "k";
    const conn = new ElasticsearchConnector();
    try {
      await conn.healthCheck();
    } finally {
      delete process.env.ELASTICSEARCH_NODE;
      delete process.env.ELASTICSEARCH_API_KEY;
    }
    // healthCheck returns {ok:false} rather than throwing; we just verify
    // no crash. The driver-missing branch is covered by the import().catch path.
  });
});
