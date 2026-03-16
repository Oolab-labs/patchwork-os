import { describe, expect, it } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import {
  createUnwatchFilesTool,
  createWatchFilesTool,
} from "../fileWatcher.js";

function mockDisconnected(): any {
  return { isConnected: () => false };
}

function mockConnected(overrides: Record<string, unknown> = {}): any {
  return {
    isConnected: () => true,
    watchFiles: async () => ({ watching: true }),
    unwatchFiles: async () => ({ removed: true }),
    ...overrides,
  };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

// ── watchFiles ────────────────────────────────────────────────────────────────

describe("watchFiles", () => {
  it("returns available: false (not isError) when disconnected", async () => {
    const tool = createWatchFilesTool(mockDisconnected());
    const result = await tool.handler({ id: "w1", pattern: "**/*.ts" });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.available).toBe(false);
  });

  it("returns error when id contains a control character", async () => {
    const tool = createWatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "bad\x01id", pattern: "**/*.ts" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("control characters");
  });

  it("returns error when pattern contains a control character", async () => {
    const tool = createWatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "w1", pattern: "**\x00/*.ts" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("control characters");
  });

  it("returns error when pattern starts with /", async () => {
    const tool = createWatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "w1", pattern: "/abs/path/**" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/absolute|workspace/i);
  });

  it("returns error when pattern starts with \\", async () => {
    const tool = createWatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "w1", pattern: "\\abs\\path" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/absolute|workspace/i);
  });

  it("returns error when pattern contains ..", async () => {
    const tool = createWatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "w1", pattern: "../outside/**" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/\.\./);
  });

  it("returns success for valid relative pattern", async () => {
    const tool = createWatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "w1", pattern: "src/**/*.ts" });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.watching).toBe(true);
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createWatchFilesTool(
      mockConnected({
        watchFiles: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler({ id: "w1", pattern: "**/*.ts" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeout|unavailable/i);
  });

  it("returns error when extension returns null", async () => {
    const tool = createWatchFilesTool(
      mockConnected({ watchFiles: async () => null }),
    );
    const result = await tool.handler({ id: "w1", pattern: "**/*.ts" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to register");
  });
});

// ── unwatchFiles ──────────────────────────────────────────────────────────────

describe("unwatchFiles", () => {
  it("returns available: false (not isError) when disconnected", async () => {
    const tool = createUnwatchFilesTool(mockDisconnected());
    const result = await tool.handler({ id: "w1" });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.available).toBe(false);
  });

  it("returns success for valid id", async () => {
    const tool = createUnwatchFilesTool(mockConnected());
    const result = await tool.handler({ id: "w1" });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.removed).toBe(true);
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createUnwatchFilesTool(
      mockConnected({
        unwatchFiles: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler({ id: "w1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeout|unavailable/i);
  });

  it("returns error when extension returns null", async () => {
    const tool = createUnwatchFilesTool(
      mockConnected({ unwatchFiles: async () => null }),
    );
    const result = await tool.handler({ id: "w1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to unregister");
  });
});
