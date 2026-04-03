import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetDebugState } from "../../handlers/debug";
import { __reset, _mockDebugSession, debug } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

describe("handleGetDebugState", () => {
  it("returns hasActiveSession: false when no active session", async () => {
    debug.activeDebugSession = undefined;
    const result = (await handleGetDebugState({})) as any;
    expect(result.hasActiveSession).toBe(false);
    expect(result.isPaused).toBe(false);
    expect(Array.isArray(result.breakpoints)).toBe(true);
  });

  it("handles customRequest returning { threads: [] } (empty array) without throwing", async () => {
    const session = _mockDebugSession({
      customRequest: vi.fn(async (cmd: string) => {
        if (cmd === "threads") return { threads: [] };
        return {};
      }),
    });
    debug.activeDebugSession = session as any;

    const result = (await handleGetDebugState({})) as any;
    expect(result.hasActiveSession).toBe(true);
    expect(result.isPaused).toBe(false);
    expect(Array.isArray(result.callStack)).toBe(true);
    expect(result.callStack).toHaveLength(0);
  });

  it("handles customRequest returning { threads: null } without throwing", async () => {
    const session = _mockDebugSession({
      customRequest: vi.fn(async (cmd: string) => {
        if (cmd === "threads") return { threads: null };
        return {};
      }),
    });
    debug.activeDebugSession = session as any;

    const result = (await handleGetDebugState({})) as any;
    expect(result.hasActiveSession).toBe(true);
    expect(result.isPaused).toBe(false);
  });

  it("handles customRequest returning unexpected shape without throwing", async () => {
    const session = _mockDebugSession({
      customRequest: vi.fn(async () => null),
    });
    debug.activeDebugSession = session as any;

    const result = (await handleGetDebugState({})) as any;
    expect(result.hasActiveSession).toBe(true);
    expect(result.isPaused).toBe(false);
  });

  it("times out if customRequest hangs and resolves gracefully", async () => {
    const session = _mockDebugSession({
      customRequest: vi.fn(
        () =>
          new Promise<unknown>(() => {
            /* never resolves */
          }),
      ),
    });
    debug.activeDebugSession = session as any;

    // Use fake timers so we don't actually wait 8 seconds
    vi.useFakeTimers();
    const promise = handleGetDebugState({});
    // Advance past the 8000ms timeout
    await vi.runAllTimersAsync();
    const result = (await promise) as any;
    vi.useRealTimers();

    expect(result.hasActiveSession).toBe(true);
    expect(result.isPaused).toBe(false);
  }, 15000);

  it("returns full call stack when session is paused", async () => {
    const session = _mockDebugSession({
      customRequest: vi.fn(async (cmd: string) => {
        if (cmd === "threads") return { threads: [{ id: 1, name: "main" }] };
        if (cmd === "stackTrace")
          return {
            stackFrames: [
              {
                id: 10,
                name: "myFunc",
                source: { path: "/app/index.ts" },
                line: 5,
                column: 1,
              },
            ],
          };
        if (cmd === "scopes")
          return { scopes: [{ name: "Local", variablesReference: 100 }] };
        if (cmd === "variables")
          return { variables: [{ name: "x", value: "42", type: "number" }] };
        return {};
      }),
    });
    debug.activeDebugSession = session as any;

    const result = (await handleGetDebugState({})) as any;
    expect(result.hasActiveSession).toBe(true);
    expect(result.isPaused).toBe(true);
    expect(result.callStack).toHaveLength(1);
    expect(result.callStack[0].name).toBe("myFunc");
    expect(result.pausedAt?.file).toBe("/app/index.ts");
    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0].variables[0].name).toBe("x");
  });

  it("handles stackTrace customRequest throwing without aborting entire state", async () => {
    const session = _mockDebugSession({
      customRequest: vi.fn(async (cmd: string) => {
        if (cmd === "threads") return { threads: [{ id: 1, name: "main" }] };
        if (cmd === "stackTrace") throw new Error("adapter error");
        return {};
      }),
    });
    debug.activeDebugSession = session as any;

    const result = (await handleGetDebugState({})) as any;
    // Should still return a valid state, not throw
    expect(result.hasActiveSession).toBe(true);
    expect(result.isPaused).toBe(false);
  });
});
