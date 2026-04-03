import { describe, expect, it, vi } from "vitest";
import { createBridgeStatusTool } from "../bridgeStatus.js";

function makeClient(
  connected: boolean,
  cbState = { suspended: false, failures: 0, suspendedUntil: 0 },
) {
  return {
    isConnected: vi.fn(() => connected),
    getCircuitBreakerState: vi.fn(() => cbState),
  } as any;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("createBridgeStatusTool", () => {
  it("returns extensionConnected:true and all-available hint when connected", async () => {
    const tool = createBridgeStatusTool(makeClient(true));
    const data = parse(await tool.handler());
    expect(data.extensionConnected).toBe(true);
    expect(data.hint).toContain("All tools available");
  });

  it("returns extensionConnected:false and reconnect hint when disconnected", async () => {
    const tool = createBridgeStatusTool(makeClient(false));
    const data = parse(await tool.handler());
    expect(data.extensionConnected).toBe(false);
    expect(data.hint).toContain("auto-reconnect");
  });

  it("returns activeSessions from sessions map when provided", async () => {
    const sessions = new Map([
      ["s1", {}],
      ["s2", {}],
    ]);
    const tool = createBridgeStatusTool(makeClient(true), sessions);
    const data = parse(await tool.handler());
    expect(data.activeSessions).toBe(2);
  });

  it("defaults activeSessions to 1 when sessions map is omitted", async () => {
    const tool = createBridgeStatusTool(makeClient(true));
    const data = parse(await tool.handler());
    expect(data.activeSessions).toBe(1);
  });

  it("includes circuitBreaker state", async () => {
    const tool = createBridgeStatusTool(
      makeClient(true, { suspended: false, failures: 2, suspendedUntil: 0 }),
    );
    const data = parse(await tool.handler());
    expect(data.circuitBreaker.suspended).toBe(false);
    expect(data.circuitBreaker.consecutiveFailures).toBe(2);
  });

  it("includes resumesInMs when circuit breaker is suspended", async () => {
    const future = Date.now() + 10_000;
    const tool = createBridgeStatusTool(
      makeClient(false, {
        suspended: true,
        failures: 5,
        suspendedUntil: future,
      }),
    );
    const data = parse(await tool.handler());
    expect(data.circuitBreaker.suspended).toBe(true);
    expect(data.circuitBreaker.resumesInMs).toBeGreaterThan(0);
  });

  it("clamps resumesInMs to 0 when suspendedUntil is in the past", async () => {
    const past = Date.now() - 1000;
    const tool = createBridgeStatusTool(
      makeClient(false, { suspended: true, failures: 5, suspendedUntil: past }),
    );
    const data = parse(await tool.handler());
    expect(data.circuitBreaker.resumesInMs).toBe(0);
  });

  it("returns tier 'full' when extension is connected", async () => {
    const tool = createBridgeStatusTool(makeClient(true));
    const data = parse(await tool.handler());
    expect(data.tier).toBe("full");
    expect(data.tierDescription).toContain("All tools available");
  });

  it("returns tier 'basic' when extension is disconnected", async () => {
    const tool = createBridgeStatusTool(makeClient(false));
    const data = parse(await tool.handler());
    expect(data.tier).toBe("basic");
    expect(data.tierDescription).toContain("Connect the VS Code extension");
  });

  it("returns uptimeSeconds as a non-negative integer", async () => {
    const tool = createBridgeStatusTool(makeClient(true));
    const data = parse(await tool.handler());
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(data.uptimeSeconds)).toBe(true);
  });
});
