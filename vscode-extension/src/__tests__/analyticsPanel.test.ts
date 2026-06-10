/**
 * Unit tests for AnalyticsSidebarProvider._handleContinueHandoff
 *
 * Focus: the "↺ Continue from handoff note" button flow.
 * - Manual note → prompt includes handoff content, runClaudeTask called
 * - Auto-snapshot note → "Start fresh" prompt, no handoff content injected
 * - Empty/null note → taskError posted to webview
 * - Bridge not running → taskError posted to webview
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsViewProvider as AnalyticsSidebarProvider } from "../analyticsPanel";
import type { LockFileData } from "../types";

// Controllable mock for node:http so we can exercise _callBridgeTool's real
// request path (timeout option + response byte cap). Default is undefined so
// the rest of the suite — which stubs _callBridgeTool directly — is unaffected.
let httpRequestImpl:
  | ((opts: unknown, cb: (res: unknown) => void) => unknown)
  | undefined;
vi.mock("node:http", () => ({
  request: (opts: unknown, cb: (res: unknown) => void) => {
    if (!httpRequestImpl) throw new Error("http.request not stubbed");
    return httpRequestImpl(opts, cb);
  },
}));

// ── helpers ─────────────────────────────────────────────────────────────────

function makeLock(): LockFileData {
  return {
    pid: 1234,
    port: 9999,
    workspace: "/workspace",
    authToken: "token",
    isBridge: true,
    startedAt: Date.now(),
  } as unknown as LockFileData;
}

function makeContext() {
  const state = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, def?: unknown) => state.get(key) ?? def,
      update: vi.fn((key: string, val: unknown) => {
        state.set(key, val);
        return Promise.resolve();
      }),
    },
    extensionUri: { fsPath: "/ext" },
  } as unknown as import("vscode").ExtensionContext;
}

function makeWebviewView() {
  const messages: unknown[] = [];
  let msgHandler: ((msg: unknown) => void) | undefined;
  return {
    webview: {
      options: {} as unknown,
      html: "",
      asWebviewUri: vi.fn((uri: unknown) => uri),
      postMessage: vi.fn((msg: unknown) => {
        messages.push(msg);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: vi.fn((handler: (msg: unknown) => void) => {
        msgHandler = handler;
        return { dispose: vi.fn() };
      }),
    },
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    visible: true,
    _messages: messages,
    _send: (msg: unknown) => msgHandler?.(msg),
  };
}

function makeVscodeApi() {
  return {
    Uri: {
      joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({
        fsPath: `/ext/${parts.join("/")}`,
        toString: () => `/ext/${parts.join("/")}`,
      })),
    },
    window: { showErrorMessage: vi.fn() },
    workspace: { workspaceFolders: [] },
  } as unknown as typeof import("vscode");
}

function makeProvider(lockOverride?: LockFileData | null) {
  const getLockFile = vi.fn(async () =>
    lockOverride !== undefined ? lockOverride : makeLock(),
  );
  const getReport = vi.fn(async () => null);
  const ctx = makeContext();
  const vscodeApi = makeVscodeApi();
  const provider = new AnalyticsSidebarProvider(
    { fsPath: "/ext" } as unknown as import("vscode").Uri,
    getReport,
    getLockFile,
    vscodeApi,
    ctx,
  );
  return { provider, getLockFile, getReport };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("_handleContinueHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses manual note content in runClaudeTask prompt", async () => {
    const { provider } = makeProvider();
    const view = makeWebviewView();

    // Wire up the webview (resolveWebviewView registers the message handler)
    provider.resolveWebviewView(
      view as unknown as import("vscode").WebviewView,
    );

    // Spy on _callBridgeTool to intercept HTTP calls
    const callSpy = vi
      .spyOn(
        provider as unknown as { _callBridgeTool: unknown },
        "_callBridgeTool",
      )
      .mockImplementation(
        async (_lock: unknown, toolName: string, _args: unknown) => {
          if (toolName === "getHandoffNote") {
            return {
              content: [
                {
                  text: JSON.stringify({
                    note: "Working on feature X. Next: write tests.",
                  }),
                },
              ],
            };
          }
          if (toolName === "runClaudeTask") {
            return {
              content: [{ text: JSON.stringify({ taskId: "task-abc" }) }],
            };
          }
          return null;
        },
      );

    // Trigger the continueHandoff flow
    view._send({ command: "continueHandoff" });

    // Allow async handlers to settle
    await new Promise((r) => setTimeout(r, 50));

    // runClaudeTask should have been called with the handoff note
    const runCall = callSpy.mock.calls.find(
      ([, tool]) => tool === "runClaudeTask",
    );
    expect(runCall).toBeDefined();
    const prompt = (runCall![2] as { prompt: string }).prompt;
    expect(prompt).toContain("Continue from where we left off");
    expect(prompt).toContain("Working on feature X");

    // webview should receive taskStarted with the taskId
    const started = view._messages.find(
      (m) => (m as { command: string }).command === "taskStarted",
    );
    expect(started).toMatchObject({
      command: "taskStarted",
      taskId: "task-abc",
    });
  });

  it("uses start-fresh prompt for auto-snapshot notes", async () => {
    const { provider } = makeProvider();
    const view = makeWebviewView();
    provider.resolveWebviewView(
      view as unknown as import("vscode").WebviewView,
    );

    const callSpy = vi
      .spyOn(
        provider as unknown as { _callBridgeTool: unknown },
        "_callBridgeTool",
      )
      .mockImplementation(async (_lock: unknown, toolName: string) => {
        if (toolName === "getHandoffNote") {
          return {
            content: [
              {
                text: JSON.stringify({
                  note: "[auto-snapshot 2026-04-15T10:00:00Z] Bridge restarted. 3 sessions active.",
                }),
              },
            ],
          };
        }
        if (toolName === "runClaudeTask") {
          return {
            content: [{ text: JSON.stringify({ taskId: "task-fresh" }) }],
          };
        }
        return null;
      });

    view._send({ command: "continueHandoff" });
    await new Promise((r) => setTimeout(r, 50));

    const runCall = callSpy.mock.calls.find(
      ([, tool]) => tool === "runClaudeTask",
    );
    expect(runCall).toBeDefined();
    const prompt = (runCall![2] as { prompt: string }).prompt;
    expect(prompt).toContain("Start a new session");
    expect(prompt).not.toContain("[auto-snapshot");
  });

  it("posts taskError when handoff note is empty", async () => {
    const { provider } = makeProvider();
    const view = makeWebviewView();
    provider.resolveWebviewView(
      view as unknown as import("vscode").WebviewView,
    );

    vi.spyOn(
      provider as unknown as { _callBridgeTool: unknown },
      "_callBridgeTool",
    ).mockImplementation(async (_lock: unknown, toolName: string) => {
      if (toolName === "getHandoffNote") {
        return { content: [{ text: JSON.stringify({ note: "  " }) }] };
      }
      return null;
    });

    view._send({ command: "continueHandoff" });
    await new Promise((r) => setTimeout(r, 50));

    const err = view._messages.find(
      (m) => (m as { command: string }).command === "taskError",
    );
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toContain("No handoff note");
  });

  it("posts taskError when bridge is not running", async () => {
    const { provider } = makeProvider(null);
    const view = makeWebviewView();
    provider.resolveWebviewView(
      view as unknown as import("vscode").WebviewView,
    );

    view._send({ command: "continueHandoff" });
    await new Promise((r) => setTimeout(r, 50));

    const err = view._messages.find(
      (m) => (m as { command: string }).command === "taskError",
    );
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toContain(
      "Bridge not running",
    );
  });

  it("posts taskStarting immediately before async work", async () => {
    const { provider } = makeProvider();
    const view = makeWebviewView();
    provider.resolveWebviewView(
      view as unknown as import("vscode").WebviewView,
    );

    // Slow mock to ensure taskStarting arrives before taskStarted
    vi.spyOn(
      provider as unknown as { _callBridgeTool: unknown },
      "_callBridgeTool",
    ).mockImplementation(async (_lock: unknown, toolName: string) => {
      await new Promise((r) => setTimeout(r, 20));
      if (toolName === "getHandoffNote") {
        return {
          content: [{ text: JSON.stringify({ note: "Some context" }) }],
        };
      }
      if (toolName === "runClaudeTask") {
        return { content: [{ text: JSON.stringify({ taskId: "task-slow" }) }] };
      }
      return null;
    });

    view._send({ command: "continueHandoff" });

    // Check taskStarting arrives quickly (before 10ms)
    await new Promise((r) => setTimeout(r, 5));
    const starting = view._messages.find(
      (m) => (m as { command: string }).command === "taskStarting",
    );
    expect(starting).toBeDefined();

    await new Promise((r) => setTimeout(r, 100));
    const started = view._messages.find(
      (m) => (m as { command: string }).command === "taskStarted",
    );
    expect(started).toMatchObject({
      command: "taskStarted",
      taskId: "task-slow",
    });
  });
});

// ── _callBridgeTool resource bounds (extension-2) ────────────────────────────
//
// Regression: the three http.request() calls inside _callBridgeTool had no
// timeout and the tools/call response accumulated bytes with no cap. A stalled
// or malicious bridge could hang the refresh timer forever or OOM the host.

interface FakeReq extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface FakeRes extends EventEmitter {
  headers: Record<string, string>;
  resume: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function makeFakeReq(): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn((err?: Error) => {
    if (err) req.emit("error", err);
  });
  return req;
}

function makeFakeRes(headers: Record<string, string> = {}): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.headers = headers;
  res.resume = vi.fn();
  res.destroy = vi.fn();
  return res;
}

describe("_callBridgeTool resource bounds", () => {
  afterEach(() => {
    httpRequestImpl = undefined;
    vi.useRealTimers();
  });

  it("passes a timeout to every bridge http.request call", async () => {
    const options: Array<Record<string, unknown>> = [];
    httpRequestImpl = (opts: unknown, cb: (res: unknown) => void) => {
      options.push(opts as Record<string, unknown>);
      const req = makeFakeReq();
      // Resolve each step so the call completes end-to-end.
      queueMicrotask(() => {
        const isInit =
          (opts as { method?: string }).method === "POST" &&
          !(opts as { headers?: Record<string, string> }).headers?.[
            "mcp-session-id"
          ];
        const res = makeFakeRes(isInit ? { "mcp-session-id": "sess-1" } : {});
        cb(res);
        res.emit("data", Buffer.from('{"result":{}}'));
        res.emit("end");
      });
      return req;
    };

    const { provider } = makeProvider();
    await (
      provider as unknown as {
        _callBridgeTool: (
          l: LockFileData,
          t: string,
          a: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    )._callBridgeTool(makeLock(), "getAnalyticsReport", {});

    expect(options.length).toBeGreaterThanOrEqual(3);
    // Every request (init, notif, tools/call) carries a finite timeout.
    for (const opt of options.slice(0, 3)) {
      expect(typeof opt.timeout).toBe("number");
      expect(opt.timeout as number).toBeGreaterThan(0);
    }
  });

  it("destroys the response and resolves null when the body exceeds the cap", async () => {
    let callRes: FakeRes | null = null;
    httpRequestImpl = (opts: unknown, cb: (res: unknown) => void) => {
      const req = makeFakeReq();
      const headers = (opts as { headers?: Record<string, string> }).headers;
      const hasSession = !!headers?.["mcp-session-id"];
      const method = (opts as { method?: string }).method;
      // Only the tools/call POST carries id:2 in its body.
      let isToolsCall = false;
      req.write = vi.fn((body: unknown) => {
        if (typeof body === "string" && body.includes('"tools/call"')) {
          isToolsCall = true;
        }
      });
      queueMicrotask(() => {
        if (!hasSession) {
          // initialize → return a session id
          const res = makeFakeRes({ "mcp-session-id": "sess-1" });
          cb(res);
          res.emit("end");
          return;
        }
        if (method === "DELETE") {
          const res = makeFakeRes();
          cb(res);
          res.emit("end");
          return;
        }
        const res = makeFakeRes();
        cb(res);
        if (isToolsCall) {
          callRes = res;
          // Stream > 512 KB to trip the byte cap.
          res.emit("data", Buffer.alloc(600 * 1024, 0x61));
        }
        res.emit("end");
      });
      return req;
    };

    const { provider } = makeProvider();
    const result = await (
      provider as unknown as {
        _callBridgeTool: (
          l: LockFileData,
          t: string,
          a: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    )._callBridgeTool(makeLock(), "getAnalyticsReport", {});

    expect(result).toBeNull();
    expect(callRes).not.toBeNull();
    expect((callRes as unknown as FakeRes).destroy).toHaveBeenCalled();
  });
});
