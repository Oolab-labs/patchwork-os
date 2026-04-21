import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connectors/mcpOAuth.js", () => ({
  getAllConnectorStatuses: vi.fn(),
}));

import { getAllConnectorStatuses } from "../../connectors/mcpOAuth.js";
import { createGetConnectorStatusTool } from "../getConnectorStatus.js";

const mockGetAll = vi.mocked(getAllConnectorStatuses);

function structured(r: {
  structuredContent?: unknown;
  content: Array<{ text: string }>;
}) {
  return (r.structuredContent ??
    JSON.parse(r.content[0]?.text ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe("createGetConnectorStatusTool", () => {
  it("returns all connectors with connected status", async () => {
    mockGetAll.mockReturnValue([
      {
        vendor: "github",
        connected: true,
        expiresAt: Date.now() + 3_600_000,
        expiresInMs: 3_600_000,
        needsReauth: false,
        profile: { login: "alice" },
      },
      {
        vendor: "linear",
        connected: true,
        expiresAt: Date.now() + 1_800_000,
        expiresInMs: 1_800_000,
        needsReauth: false,
      },
      { vendor: "sentry", connected: false, needsReauth: false },
    ]);

    const tool = createGetConnectorStatusTool();
    const result = structured(await tool.handler({}));
    const connectors = result.connectors as Array<Record<string, unknown>>;

    expect(connectors).toHaveLength(3);
    expect(connectors[0]?.vendor).toBe("github");
    expect(connectors[0]?.connected).toBe(true);
    expect(connectors[0]?.needsReauth).toBe(false);
    expect(connectors[0]?.profile).toEqual({ login: "alice" });
    expect(connectors[2]?.connected).toBe(false);
  });

  it("includes expiresInMinutes when expiresInMs present", async () => {
    mockGetAll.mockReturnValue([
      {
        vendor: "linear",
        connected: true,
        expiresAt: Date.now() + 3_600_000,
        expiresInMs: 3_600_000,
        needsReauth: false,
      },
    ]);

    const tool = createGetConnectorStatusTool();
    const result = structured(await tool.handler({}));
    const c = (result.connectors as Array<Record<string, unknown>>)[0];

    expect(c?.expiresInMinutes).toBe(60);
    expect(c?.expiresInMs).toBeDefined();
  });

  it("omits expiresAt and expiresInMs when not present", async () => {
    mockGetAll.mockReturnValue([
      { vendor: "github", connected: false, needsReauth: false },
    ]);

    const tool = createGetConnectorStatusTool();
    const result = structured(await tool.handler({}));
    const c = (result.connectors as Array<Record<string, unknown>>)[0];

    expect(c?.expiresAt).toBeUndefined();
    expect(c?.expiresInMs).toBeUndefined();
    expect(c?.expiresInMinutes).toBeUndefined();
  });

  it("surfaces needsReauth: true when token expired with no refresh", async () => {
    mockGetAll.mockReturnValue([
      {
        vendor: "sentry",
        connected: true,
        expiresAt: Date.now() - 1000,
        expiresInMs: -1000,
        needsReauth: true,
      },
    ]);

    const tool = createGetConnectorStatusTool();
    const result = structured(await tool.handler({}));
    const c = (result.connectors as Array<Record<string, unknown>>)[0];

    expect(c?.needsReauth).toBe(true);
  });

  it("omits profile when not present", async () => {
    mockGetAll.mockReturnValue([
      { vendor: "linear", connected: true, needsReauth: false },
    ]);

    const tool = createGetConnectorStatusTool();
    const result = structured(await tool.handler({}));
    const c = (result.connectors as Array<Record<string, unknown>>)[0];

    expect(c?.profile).toBeUndefined();
  });

  it("has correct schema name and no required inputs", () => {
    const tool = createGetConnectorStatusTool();
    expect(tool.schema.name).toBe("getConnectorStatus");
    expect(tool.schema.inputSchema.properties).toEqual({});
    expect(tool.schema.outputSchema.required).toContain("connectors");
  });

  it("returns empty connectors array when getAllConnectorStatuses returns []", async () => {
    mockGetAll.mockReturnValue([]);

    const tool = createGetConnectorStatusTool();
    const result = structured(await tool.handler({}));

    expect(result.connectors).toEqual([]);
  });
});
