import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import {
  createEvaluateInDebuggerTool,
  createSetDebugBreakpointsTool,
  createStartDebuggingTool,
  createStopDebuggingTool,
} from "../debug.js";
import { createGetDebugStateTool } from "../getDebugState.js";

let WORKSPACE: string;
let TEST_FILE: string;

beforeAll(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "debug-tool-test-"));
  TEST_FILE = path.join(WORKSPACE, "index.ts");
  fs.writeFileSync(TEST_FILE, "const x = 1;\n");
});

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

function mockDisconnected(): any {
  return { isConnected: () => false };
}

function mockConnected(overrides: Record<string, unknown> = {}): any {
  return {
    isConnected: () => true,
    getDebugState: async () => null,
    evaluateInDebugger: async () => null,
    setDebugBreakpoints: async () => null,
    startDebugging: async () => null,
    stopDebugging: async () => null,
    ...overrides,
  };
}

function text(result: any): string {
  return result.content?.[0]?.text ?? "";
}

// ── getDebugState ─────────────────────────────────────────────────────────────

describe("getDebugState", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createGetDebugStateTool(mockDisconnected());
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("getDebugState");
  });

  it("returns empty state when extension returns null", async () => {
    const tool = createGetDebugStateTool(
      mockConnected({ getDebugState: async () => null }),
    );
    const result = await tool.handler();
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.hasActiveSession).toBe(false);
    expect(data.isPaused).toBe(false);
    expect(data.breakpoints).toEqual([]);
  });

  it("passes through debug state from extension", async () => {
    const state = {
      hasActiveSession: true,
      isPaused: true,
      sessionId: "abc",
      breakpoints: [{ file: "/src/index.ts", line: 10 }],
    };
    const tool = createGetDebugStateTool(
      mockConnected({ getDebugState: async () => state }),
    );
    const result = await tool.handler();
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.hasActiveSession).toBe(true);
    expect(data.sessionId).toBe("abc");
    expect(data.breakpoints).toHaveLength(1);
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createGetDebugStateTool(
      mockConnected({
        getDebugState: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
  });
});

// ── evaluateInDebugger ────────────────────────────────────────────────────────

describe("evaluateInDebugger", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createEvaluateInDebuggerTool(mockDisconnected());
    const result = await tool.handler({ expression: "x" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("evaluateInDebugger");
  });

  it("throws when expression is missing", async () => {
    const tool = createEvaluateInDebuggerTool(mockConnected());
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("returns error when extension returns null", async () => {
    const tool = createEvaluateInDebuggerTool(
      mockConnected({ evaluateInDebugger: async () => null }),
    );
    const result = await tool.handler({ expression: "myVar" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No active debug session");
  });

  it("passes expression result through", async () => {
    const evalResult = { result: "42", type: "number" };
    const tool = createEvaluateInDebuggerTool(
      mockConnected({ evaluateInDebugger: async () => evalResult }),
    );
    const result = await tool.handler({ expression: "myVar" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.result).toBe("42");
  });

  it("forwards frameId and context params", async () => {
    let capturedArgs: unknown[] = [];
    const tool = createEvaluateInDebuggerTool(
      mockConnected({
        evaluateInDebugger: async (...args: unknown[]) => {
          capturedArgs = args;
          return { result: "ok" };
        },
      }),
    );
    await tool.handler({ expression: "x", frameId: 2, context: "watch" });
    expect(capturedArgs[0]).toBe("x");
    expect(capturedArgs[1]).toBe(2);
    expect(capturedArgs[2]).toBe("watch");
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createEvaluateInDebuggerTool(
      mockConnected({
        evaluateInDebugger: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler({ expression: "x" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
  });
});

// ── setDebugBreakpoints ───────────────────────────────────────────────────────

describe("setDebugBreakpoints", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createSetDebugBreakpointsTool(WORKSPACE, mockDisconnected());
    const result = await tool.handler({
      file: TEST_FILE,
      breakpoints: [],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("setDebugBreakpoints");
  });

  it("throws when breakpoints array contains non-object", async () => {
    const tool = createSetDebugBreakpointsTool(WORKSPACE, mockConnected());
    await expect(
      tool.handler({
        file: TEST_FILE,
        breakpoints: ["not-an-object"],
      }),
    ).rejects.toThrow();
  });

  it("throws when breakpoint is missing line field", async () => {
    const tool = createSetDebugBreakpointsTool(WORKSPACE, mockConnected());
    await expect(
      tool.handler({
        file: TEST_FILE,
        breakpoints: [{ condition: "x > 5" }],
      }),
    ).rejects.toThrow();
  });

  it("accepts empty array to clear breakpoints", async () => {
    const tool = createSetDebugBreakpointsTool(
      WORKSPACE,
      mockConnected({ setDebugBreakpoints: async () => ({ cleared: true }) }),
    );
    const result = await tool.handler({
      file: TEST_FILE,
      breakpoints: [],
    });
    expect(result.isError).toBeFalsy();
  });

  it("passes through condition, logMessage, hitCondition", async () => {
    let captured: unknown;
    const tool = createSetDebugBreakpointsTool(
      WORKSPACE,
      mockConnected({
        setDebugBreakpoints: async (_file: string, bps: unknown) => {
          captured = bps;
          return { set: true };
        },
      }),
    );
    await tool.handler({
      file: TEST_FILE,
      breakpoints: [
        { line: 5, condition: "x > 0", logMessage: "hit!", hitCondition: ">3" },
      ],
    });
    expect((captured as any[])[0].condition).toBe("x > 0");
    expect((captured as any[])[0].logMessage).toBe("hit!");
    expect((captured as any[])[0].hitCondition).toBe(">3");
  });

  it("returns error when extension returns null", async () => {
    const tool = createSetDebugBreakpointsTool(
      WORKSPACE,
      mockConnected({ setDebugBreakpoints: async () => null }),
    );
    const result = await tool.handler({
      file: TEST_FILE,
      breakpoints: [{ line: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Failed to set breakpoints");
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createSetDebugBreakpointsTool(
      WORKSPACE,
      mockConnected({
        setDebugBreakpoints: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler({
      file: TEST_FILE,
      breakpoints: [{ line: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
  });
});

// ── startDebugging ────────────────────────────────────────────────────────────

describe("startDebugging", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createStartDebuggingTool(mockDisconnected());
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("startDebugging");
  });

  it("starts without configName", async () => {
    const tool = createStartDebuggingTool(
      mockConnected({ startDebugging: async () => ({ started: true }) }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
  });

  it("passes configName to extension", async () => {
    let capturedName: unknown;
    const tool = createStartDebuggingTool(
      mockConnected({
        startDebugging: async (name: unknown) => {
          capturedName = name;
          return { started: true };
        },
      }),
    );
    await tool.handler({ configName: "Launch Server" });
    expect(capturedName).toBe("Launch Server");
  });

  it("returns error when extension returns null", async () => {
    const tool = createStartDebuggingTool(
      mockConnected({ startDebugging: async () => null }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Failed to start");
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createStartDebuggingTool(
      mockConnected({
        startDebugging: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
  });
});

// ── stopDebugging ─────────────────────────────────────────────────────────────

describe("stopDebugging", () => {
  it("returns extensionRequired when disconnected", async () => {
    const tool = createStopDebuggingTool(mockDisconnected());
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("stopDebugging");
  });

  it("returns error when extension returns null", async () => {
    const tool = createStopDebuggingTool(
      mockConnected({ stopDebugging: async () => null }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Failed to stop");
  });

  it("returns success when extension confirms stop", async () => {
    const tool = createStopDebuggingTool(
      mockConnected({ stopDebugging: async () => ({ stopped: true }) }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.stopped).toBe(true);
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createStopDebuggingTool(
      mockConnected({
        stopDebugging: async () => {
          throw new ExtensionTimeoutError("timeout");
        },
      }),
    );
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
  });
});
