/**
 * Redis recipe-step tools — read-only set (get, keys, hgetall, info).
 *
 * Mocks the Redis connector module so the self-registering tool module can be
 * imported and each tool exercised through the registry without a live Redis
 * server or stored credentials. Asserts faithful positional param mapping into
 * the connector calls and that the raw connector return type is
 * JSON-stringified back out. Verifies isWrite/risk metadata: every tool is
 * non-write / low risk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getRedisConnector returns it.

const get = vi.fn();
const keys = vi.fn();
const hgetall = vi.fn();
const info = vi.fn();

vi.mock("../../../connectors/redis.js", () => ({
  getRedisConnector: () => ({
    get,
    keys,
    hgetall,
    info,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../redis.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("redis recipe-step tools", () => {
  beforeEach(() => {
    get.mockReset();
    keys.mockReset();
    hgetall.mockReset();
    info.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers all four tools with the redis namespace + outputSchema", () => {
    for (const id of [
      "redis.get",
      "redis.keys",
      "redis.hgetall",
      "redis.info",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("redis");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("all tools are non-write / low risk", () => {
    for (const id of [
      "redis.get",
      "redis.keys",
      "redis.hgetall",
      "redis.info",
    ]) {
      const tool = getTool(id);
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
    }
  });

  // ── redis.get ───────────────────────────────────────────────────────────────

  it("get forwards the key and stringifies the value", async () => {
    get.mockResolvedValue("hello");

    const tool = getTool("redis.get");
    const out = await tool?.execute(makeContext({ key: "greeting" }));

    expect(get).toHaveBeenCalledWith("greeting");
    expect(out).toBe(JSON.stringify("hello"));
  });

  it("get stringifies a null miss", async () => {
    get.mockResolvedValue(null);

    const tool = getTool("redis.get");
    const out = await tool?.execute(makeContext({ key: "missing" }));

    expect(get).toHaveBeenCalledWith("missing");
    expect(out).toBe(JSON.stringify(null));
  });

  // ── redis.keys ──────────────────────────────────────────────────────────────

  it("keys forwards pattern + limit positionally and stringifies the array", async () => {
    const matched = ["user:1", "user:2"];
    keys.mockResolvedValue(matched);

    const tool = getTool("redis.keys");
    const out = await tool?.execute(
      makeContext({ pattern: "user:*", limit: 50 }),
    );

    expect(keys).toHaveBeenCalledWith("user:*", 50);
    expect(out).toBe(JSON.stringify(matched));
  });

  it("keys passes undefined limit when omitted / wrong-typed", async () => {
    keys.mockResolvedValue([]);

    const tool = getTool("redis.keys");
    await tool?.execute(makeContext({ pattern: "user:*", limit: "nope" }));

    expect(keys).toHaveBeenCalledWith("user:*", undefined);
  });

  // ── redis.hgetall ─────────────────────────────────────────────────────────--

  it("hgetall forwards the key and stringifies the field/value map", async () => {
    const hash = { name: "ada", role: "admin" };
    hgetall.mockResolvedValue(hash);

    const tool = getTool("redis.hgetall");
    const out = await tool?.execute(makeContext({ key: "user:1" }));

    expect(hgetall).toHaveBeenCalledWith("user:1");
    expect(out).toBe(JSON.stringify(hash));
  });

  // ── redis.info ────────────────────────────────────────────────────────────--

  it("info forwards the section and stringifies the parsed map", async () => {
    const parsed = { used_memory: "1024", maxmemory: "0" };
    info.mockResolvedValue(parsed);

    const tool = getTool("redis.info");
    const out = await tool?.execute(makeContext({ section: "memory" }));

    expect(info).toHaveBeenCalledWith("memory");
    expect(out).toBe(JSON.stringify(parsed));
  });

  it("info passes undefined section when omitted / wrong-typed", async () => {
    info.mockResolvedValue({ redis_version: "7.2.0" });

    const tool = getTool("redis.info");
    await tool?.execute(makeContext({ section: 123 }));

    expect(info).toHaveBeenCalledWith(undefined);
  });
});
