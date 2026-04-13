import { describe, expect, it, vi } from "vitest";
import type { ProbeResults } from "../../probe.js";
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

function makeProbes(overrides: Partial<ProbeResults> = {}): ProbeResults {
  return {
    rg: true,
    fd: true,
    git: true,
    gh: true,
    tsc: true,
    eslint: true,
    pyright: true,
    ruff: true,
    cargo: true,
    go: true,
    biome: true,
    prettier: true,
    black: true,
    gofmt: true,
    rustfmt: true,
    vitest: true,
    jest: true,
    pytest: true,
    codex: true,
    ...overrides,
  };
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("createBridgeStatusTool", () => {
  it("returns extensionConnected:true and all-available hint when connected", async () => {
    const tool = createBridgeStatusTool(makeClient(true), makeProbes());
    const data = parse(await tool.handler());
    expect(data.extensionConnected).toBe(true);
    expect(data.hint).toContain("All tools available");
  });

  it("returns extensionConnected:false and reconnect hint when disconnected", async () => {
    const tool = createBridgeStatusTool(makeClient(false), makeProbes());
    const data = parse(await tool.handler());
    expect(data.extensionConnected).toBe(false);
    expect(data.hint).toContain("auto-reconnect");
  });

  it("returns activeSessions from sessions map when provided", async () => {
    const sessions = new Map([
      ["s1", {}],
      ["s2", {}],
    ]);
    const tool = createBridgeStatusTool(
      makeClient(true),
      makeProbes(),
      sessions,
    );
    const data = parse(await tool.handler());
    expect(data.activeSessions).toBe(2);
  });

  it("defaults activeSessions to 1 when sessions map is omitted", async () => {
    const tool = createBridgeStatusTool(makeClient(true), makeProbes());
    const data = parse(await tool.handler());
    expect(data.activeSessions).toBe(1);
  });

  it("includes circuitBreaker state", async () => {
    const tool = createBridgeStatusTool(
      makeClient(true, { suspended: false, failures: 2, suspendedUntil: 0 }),
      makeProbes(),
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
      makeProbes(),
    );
    const data = parse(await tool.handler());
    expect(data.circuitBreaker.suspended).toBe(true);
    expect(data.circuitBreaker.resumesInMs).toBeGreaterThan(0);
  });

  it("clamps resumesInMs to 0 when suspendedUntil is in the past", async () => {
    const past = Date.now() - 1000;
    const tool = createBridgeStatusTool(
      makeClient(false, { suspended: true, failures: 5, suspendedUntil: past }),
      makeProbes(),
    );
    const data = parse(await tool.handler());
    expect(data.circuitBreaker.resumesInMs).toBe(0);
  });

  it("returns tier 'full' when extension is connected", async () => {
    const tool = createBridgeStatusTool(makeClient(true), makeProbes());
    const data = parse(await tool.handler());
    expect(data.tier).toBe("full");
    expect(data.tierDescription).toContain("All tools available");
  });

  it("returns tier 'basic' when extension is disconnected", async () => {
    const tool = createBridgeStatusTool(makeClient(false), makeProbes());
    const data = parse(await tool.handler());
    expect(data.tier).toBe("basic");
    expect(data.tierDescription).toContain("Connect the VS Code extension");
  });

  it("returns uptimeSeconds as a non-negative integer", async () => {
    const tool = createBridgeStatusTool(makeClient(true), makeProbes());
    const data = parse(await tool.handler());
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(data.uptimeSeconds)).toBe(true);
  });

  it("includes lastDisconnect when getDisconnectInfo is provided", async () => {
    const info = {
      at: "2026-04-12T00:00:00.000Z",
      code: 1006,
      reason: null,
    };
    const tool = createBridgeStatusTool(
      makeClient(true),
      makeProbes(),
      undefined,
      undefined,
      undefined,
      () => info,
    );
    const data = parse(await tool.handler());
    expect(data.lastDisconnect).toEqual(info);
  });

  it("omits lastDisconnect when getDisconnectInfo is not provided", async () => {
    const tool = createBridgeStatusTool(makeClient(true), makeProbes());
    const data = parse(await tool.handler());
    expect(data.lastDisconnect).toBeUndefined();
  });

  it("returns lastDisconnect with null fields when no prior disconnect", async () => {
    const tool = createBridgeStatusTool(
      makeClient(true),
      makeProbes(),
      undefined,
      undefined,
      undefined,
      () => ({ at: null, code: null, reason: null }),
    );
    const data = parse(await tool.handler());
    expect(data.lastDisconnect).toEqual({ at: null, code: null, reason: null });
  });

  // ── v2.25.25: toolAvailability field ─────────────────────────────────────

  it("toolAvailability: every entry is { available: true } when all probes true and extension connected", async () => {
    const tool = createBridgeStatusTool(makeClient(true), makeProbes());
    const data = parse(await tool.handler());
    expect(data.toolAvailability).toBeDefined();
    // Spot-check: a few known entries
    expect(data.toolAvailability.formatDocument).toEqual({ available: true });
    expect(data.toolAvailability.findImplementations).toEqual({
      available: true,
    });
    expect(data.toolAvailability.runTests).toEqual({ available: true });
    // No entry should have a reason
    for (const [, avail] of Object.entries(data.toolAvailability) as [
      string,
      { available: boolean; reason?: string },
    ][]) {
      expect(avail.available).toBe(true);
      expect(avail.reason).toBeUndefined();
    }
  });

  it("toolAvailability: extensionRequired tools report 'extension_disconnected' when disconnected", async () => {
    const tool = createBridgeStatusTool(makeClient(false), makeProbes());
    const data = parse(await tool.handler());
    expect(data.toolAvailability.findImplementations).toEqual({
      available: false,
      reason: "extension_disconnected",
    });
    expect(data.toolAvailability.setEditorDecorations).toEqual({
      available: false,
      reason: "extension_disconnected",
    });
    // Probe-gated tools without extensionRequired are still available
    expect(data.toolAvailability.formatDocument).toEqual({ available: true });
  });

  it("toolAvailability: extensionRequired tools report 'circuit_breaker_open' when breaker is tripped", async () => {
    const tool = createBridgeStatusTool(
      makeClient(true, {
        suspended: true,
        failures: 5,
        suspendedUntil: Date.now() + 10_000,
      }),
      makeProbes(),
    );
    const data = parse(await tool.handler());
    expect(data.toolAvailability.findImplementations).toEqual({
      available: false,
      reason: "circuit_breaker_open",
    });
  });

  it("toolAvailability: pure-probe tools report 'missing_probe' when probe is false", async () => {
    const tool = createBridgeStatusTool(
      makeClient(true),
      makeProbes({ vitest: false, git: false }),
    );
    const data = parse(await tool.handler());
    expect(data.toolAvailability.runTests).toEqual({
      available: false,
      reason: "missing_probe:vitest",
    });
    expect(data.toolAvailability.getGitStatus).toEqual({
      available: false,
      reason: "missing_probe:git",
    });
  });

  it("toolAvailability: extensionFallback tools are available via extension even when probe is missing", async () => {
    // Regression for v2.25.25 dogfood finding: formatDocument was reported
    // missing_probe:prettier even though the VS Code extension formatter
    // path was fully working. Dual-path tools should be available if either
    // the extension OR the probe is present.
    const tool = createBridgeStatusTool(
      makeClient(true),
      makeProbes({ prettier: false }),
    );
    const data = parse(await tool.handler());
    expect(data.toolAvailability.formatDocument).toEqual({ available: true });
  });

  it("toolAvailability: extensionFallback tools are available via probe when extension is disconnected", async () => {
    const tool = createBridgeStatusTool(
      makeClient(false),
      makeProbes({ prettier: true }),
    );
    const data = parse(await tool.handler());
    expect(data.toolAvailability.formatDocument).toEqual({ available: true });
  });

  it("toolAvailability: extensionFallback tools report unavailable when BOTH extension disconnected AND probe missing", async () => {
    const tool = createBridgeStatusTool(
      makeClient(false),
      makeProbes({ prettier: false }),
    );
    const data = parse(await tool.handler());
    expect(data.toolAvailability.formatDocument).toEqual({
      available: false,
      reason: "extension_disconnected_and_missing_probe:prettier",
    });
  });
});
