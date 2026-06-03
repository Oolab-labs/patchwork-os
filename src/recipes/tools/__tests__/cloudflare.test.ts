/**
 * Cloudflare recipe-step tools — read set (list_zones, list_dns_records,
 * get_zone_analytics) plus a single write (create_dns_record).
 *
 * Mocks the Cloudflare connector module so the self-registering tool module can
 * be imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful positional param mapping into the
 * connector calls, that the raw connector return type is JSON-stringified back
 * out, and that only create_dns_record is write-gated (isWrite: true).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getCloudflareConnector returns it.

const listZones = vi.fn();
const listDnsRecords = vi.fn();
const createDnsRecord = vi.fn();
const getZoneAnalytics = vi.fn();

vi.mock("../../../connectors/cloudflare.js", () => ({
  getCloudflareConnector: () => ({
    listZones,
    listDnsRecords,
    createDnsRecord,
    getZoneAnalytics,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../cloudflare.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("cloudflare recipe-step tools", () => {
  beforeEach(() => {
    listZones.mockReset();
    listDnsRecords.mockReset();
    createDnsRecord.mockReset();
    getZoneAnalytics.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers the three read tools as low-risk / non-write", () => {
    for (const id of [
      "cloudflare.list_zones",
      "cloudflare.list_dns_records",
      "cloudflare.get_zone_analytics",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("cloudflare");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("registers create_dns_record as a write-gated medium-risk tool", () => {
    const tool = getTool("cloudflare.create_dns_record");
    expect(tool, "create_dns_record should be registered").toBeDefined();
    expect(tool?.namespace).toBe("cloudflare");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
  });

  // ── cloudflare.list_zones ───────────────────────────────────────────────────

  it("list_zones forwards the name filter and stringifies the array", async () => {
    const zones = [
      {
        id: "zone_1",
        name: "example.com",
        status: "active",
        nameservers: ["ns1.cloudflare.com"],
        plan: { name: "Free" },
      },
    ];
    listZones.mockResolvedValue(zones);

    const tool = getTool("cloudflare.list_zones");
    const out = await tool?.execute(makeContext({ name: "example.com" }));

    expect(listZones).toHaveBeenCalledWith("example.com");
    expect(out).toBe(JSON.stringify(zones));
  });

  it("list_zones passes undefined when name omitted / wrong-typed", async () => {
    listZones.mockResolvedValue([]);

    const tool = getTool("cloudflare.list_zones");
    await tool?.execute(makeContext({ name: 42 }));

    expect(listZones).toHaveBeenCalledWith(undefined);
  });

  // ── cloudflare.list_dns_records ─────────────────────────────────────────────

  it("list_dns_records forwards zoneId/type/name positionally and stringifies", async () => {
    const records = [
      {
        id: "rec_1",
        type: "A",
        name: "www.example.com",
        content: "192.0.2.1",
        ttl: 1,
        proxied: true,
        proxiable: true,
        created_on: "2026-01-01T00:00:00Z",
        modified_on: "2026-01-02T00:00:00Z",
      },
    ];
    listDnsRecords.mockResolvedValue(records);

    const tool = getTool("cloudflare.list_dns_records");
    const out = await tool?.execute(
      makeContext({ zoneId: "zone_1", type: "A", name: "www.example.com" }),
    );

    expect(listDnsRecords).toHaveBeenCalledWith(
      "zone_1",
      "A",
      "www.example.com",
    );
    expect(out).toBe(JSON.stringify(records));
  });

  it("list_dns_records passes undefined for omitted optional filters", async () => {
    listDnsRecords.mockResolvedValue([]);

    const tool = getTool("cloudflare.list_dns_records");
    await tool?.execute(makeContext({ zoneId: "zone_1" }));

    expect(listDnsRecords).toHaveBeenCalledWith("zone_1", undefined, undefined);
  });

  // ── cloudflare.create_dns_record ────────────────────────────────────────────

  it("create_dns_record forwards all positional args and stringifies the record", async () => {
    const record = {
      id: "rec_2",
      type: "A",
      name: "api.example.com",
      content: "203.0.113.5",
      ttl: 3600,
      proxied: false,
      proxiable: true,
      created_on: "2026-06-01T00:00:00Z",
      modified_on: "2026-06-01T00:00:00Z",
    };
    createDnsRecord.mockResolvedValue(record);

    const tool = getTool("cloudflare.create_dns_record");
    const out = await tool?.execute(
      makeContext({
        zoneId: "zone_1",
        type: "A",
        name: "api.example.com",
        content: "203.0.113.5",
        ttl: 3600,
        proxied: false,
      }),
    );

    expect(createDnsRecord).toHaveBeenCalledWith(
      "zone_1",
      "A",
      "api.example.com",
      "203.0.113.5",
      3600,
      false,
    );
    expect(out).toBe(JSON.stringify(record));
  });

  it("create_dns_record passes undefined for omitted ttl / proxied", async () => {
    createDnsRecord.mockResolvedValue({
      id: "rec_3",
      type: "CNAME",
      name: "blog.example.com",
      content: "example.com",
      ttl: 1,
      proxied: true,
      proxiable: true,
      created_on: "2026-06-01T00:00:00Z",
      modified_on: "2026-06-01T00:00:00Z",
    });

    const tool = getTool("cloudflare.create_dns_record");
    await tool?.execute(
      makeContext({
        zoneId: "zone_1",
        type: "CNAME",
        name: "blog.example.com",
        content: "example.com",
      }),
    );

    expect(createDnsRecord).toHaveBeenCalledWith(
      "zone_1",
      "CNAME",
      "blog.example.com",
      "example.com",
      undefined,
      undefined,
    );
  });

  // ── cloudflare.get_zone_analytics ───────────────────────────────────────────

  it("get_zone_analytics forwards zoneId/since/until positionally and stringifies", async () => {
    const analytics = { totals: { requests: { all: 1234 } } };
    getZoneAnalytics.mockResolvedValue(analytics);

    const tool = getTool("cloudflare.get_zone_analytics");
    const out = await tool?.execute(
      makeContext({
        zoneId: "zone_1",
        since: "-10080",
        until: "0",
      }),
    );

    expect(getZoneAnalytics).toHaveBeenCalledWith("zone_1", "-10080", "0");
    expect(out).toBe(JSON.stringify(analytics));
  });

  it("get_zone_analytics passes undefined for omitted since / until", async () => {
    getZoneAnalytics.mockResolvedValue({});

    const tool = getTool("cloudflare.get_zone_analytics");
    await tool?.execute(makeContext({ zoneId: "zone_1" }));

    expect(getZoneAnalytics).toHaveBeenCalledWith(
      "zone_1",
      undefined,
      undefined,
    );
  });
});
