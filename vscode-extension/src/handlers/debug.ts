import * as vscode from "vscode";
import type { RequestHandler } from "../types";

const CUSTOM_REQUEST_TIMEOUT_MS = 8000;

/** Race a promise against a timeout. Rejects with an error on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`customRequest timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface DebugHandlerDeps {
  getBridge: () => {
    sendNotification(method: string, params: unknown): void;
  } | null;
}

function sendDebugNotification(deps: DebugHandlerDeps): void {
  const bridge = deps.getBridge();
  if (!bridge) return;
  const session = vscode.debug.activeDebugSession;
  const breakpoints = vscode.debug.breakpoints
    .filter(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint,
    )
    .map((bp) => ({
      file: bp.location.uri.fsPath,
      line: bp.location.range.start.line + 1,
      condition: bp.condition,
      enabled: bp.enabled,
    }));
  bridge.sendNotification("extension/debugSessionChanged", {
    hasActiveSession: !!session,
    sessionId: session?.id,
    sessionName: session?.name,
    sessionType: session?.type,
    isPaused: false, // updated by pause events
    breakpoints,
  });
}

type TimedRequest = (command: string, args?: unknown) => Promise<unknown>;

async function getActiveThreadId(timedRequest: TimedRequest): Promise<number> {
  const threads = await timedRequest("threads");
  // biome-ignore lint/suspicious/noExplicitAny: DAP protocol response has no TS types
  const list = (threads as any)?.threads;
  return Array.isArray(list) && list.length > 0
    ? ((list[0] as Record<string, unknown>).id as number)
    : 1;
}

async function collectCallStack(
  threadId: number,
  timedRequest: TimedRequest,
): Promise<{
  callStack: unknown[];
  pausedAt: unknown;
  topFrame: Record<string, unknown> | null;
}> {
  let frames: Array<Record<string, unknown>> = [];
  try {
    const stackResponse = await timedRequest("stackTrace", {
      threadId,
      levels: 20,
    });
    // biome-ignore lint/suspicious/noExplicitAny: DAP protocol response has no TS types
    const raw = stackResponse as any;
    frames = Array.isArray(raw?.stackFrames) ? raw.stackFrames : [];
  } catch {
    // Stack trace unavailable — session may not be paused
  }

  const callStack = frames.map((f) => ({
    id: f.id,
    name: f.name,
    file: (f.source as Record<string, unknown> | undefined)?.path ?? "",
    line: f.line,
    column: f.column,
  }));

  const topFrame = frames[0] ?? null;
  const pausedAt = topFrame
    ? {
        file:
          (topFrame.source as Record<string, unknown> | undefined)?.path ?? "",
        line: topFrame.line,
        column: topFrame.column,
      }
    : undefined;

  return { callStack, pausedAt, topFrame };
}

async function inspectScopes(
  topFrame: Record<string, unknown>,
  timedRequest: TimedRequest,
): Promise<unknown[]> {
  const scopes: unknown[] = [];
  try {
    const scopesResponse = await timedRequest("scopes", {
      frameId: topFrame.id,
    });
    // biome-ignore lint/suspicious/noExplicitAny: DAP protocol response has no TS types
    const rawRes = scopesResponse as any;
    const rawScopes: Array<Record<string, unknown>> = Array.isArray(
      rawRes?.scopes,
    )
      ? rawRes.scopes
      : [];

    for (const scope of rawScopes.slice(0, 3)) {
      try {
        const varsResponse = await timedRequest("variables", {
          variablesReference: scope.variablesReference,
          count: 50,
        });
        // biome-ignore lint/suspicious/noExplicitAny: DAP protocol response has no TS types
        const rawVars = varsResponse as any;
        const vars: Array<Record<string, unknown>> = Array.isArray(
          rawVars?.variables,
        )
          ? rawVars.variables
          : [];
        scopes.push({
          name: scope.name,
          variables: vars.slice(0, 50).map((v) => ({
            name: v.name,
            value: v.value,
            type: v.type ?? "",
          })),
        });
      } catch {
        // Variables unavailable for this scope
      }
    }
  } catch {
    // Scopes unavailable — continue with empty scopes
  }
  return scopes;
}

export const handleGetDebugState: RequestHandler = async () => {
  const session = vscode.debug.activeDebugSession;
  const breakpoints = vscode.debug.breakpoints
    .filter(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint,
    )
    .map((bp) => ({
      file: bp.location.uri.fsPath,
      line: bp.location.range.start.line + 1,
      condition: bp.condition,
      enabled: bp.enabled,
    }));

  if (!session) {
    return { hasActiveSession: false, isPaused: false, breakpoints };
  }

  const timedRequest: TimedRequest = (command, args) =>
    withTimeout(
      Promise.resolve(session.customRequest(command, args)),
      CUSTOM_REQUEST_TIMEOUT_MS,
    );

  let callStack: unknown[] = [];
  let pausedAt: unknown;
  let scopes: unknown[] = [];

  try {
    const threadId = await getActiveThreadId(timedRequest);
    const stack = await collectCallStack(threadId, timedRequest);
    callStack = stack.callStack;
    pausedAt = stack.pausedAt;
    if (stack.topFrame) {
      scopes = await inspectScopes(stack.topFrame, timedRequest);
    }
  } catch {
    // Session may not be paused or adapter may not support these requests
  }

  return {
    hasActiveSession: true,
    sessionId: session.id,
    sessionName: session.name,
    sessionType: session.type,
    isPaused: callStack.length > 0,
    pausedAt,
    callStack,
    scopes,
    breakpoints,
  };
};

const handleEvaluateInDebugger: RequestHandler = async (params) => {
  const expression = params.expression;
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("expression is required");
  }
  const frameId =
    typeof params.frameId === "number" ? params.frameId : undefined;
  const context = typeof params.context === "string" ? params.context : "repl";

  const session = vscode.debug.activeDebugSession;
  if (!session) {
    throw new Error("No active debug session");
  }

  const response = await session.customRequest("evaluate", {
    expression,
    frameId,
    context,
  });
  return {
    result: response?.result ?? "",
    type: response?.type,
    variablesReference: response?.variablesReference,
  };
};

const handleSetDebugBreakpoints: RequestHandler = async (params) => {
  const file = params.file;
  if (typeof file !== "string") throw new Error("file is required");

  const specs = Array.isArray(params.breakpoints) ? params.breakpoints : [];
  const uri = vscode.Uri.file(file);

  // Remove existing breakpoints for this file
  const existing = vscode.debug.breakpoints.filter(
    (bp): bp is vscode.SourceBreakpoint =>
      bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === file,
  );
  if (existing.length > 0) {
    vscode.debug.removeBreakpoints(existing);
  }

  // Add new breakpoints
  const newBps = specs.map((spec: Record<string, unknown>) => {
    const line = typeof spec.line === "number" ? spec.line : 1;
    const location = new vscode.Location(uri, new vscode.Position(line - 1, 0));
    return new vscode.SourceBreakpoint(
      location,
      true, // enabled
      typeof spec.condition === "string" ? spec.condition : undefined,
      typeof spec.hitCondition === "string" ? spec.hitCondition : undefined,
      typeof spec.logMessage === "string" ? spec.logMessage : undefined,
    );
  });

  if (newBps.length > 0) {
    vscode.debug.addBreakpoints(newBps);
  }

  return { set: newBps.length, file };
};

const handleStartDebugging: RequestHandler = async (params) => {
  const configName =
    typeof params.configName === "string" ? params.configName : undefined;
  const folder = vscode.workspace.workspaceFolders?.[0];

  const started = await vscode.debug.startDebugging(folder, configName ?? "");
  return { started };
};

const handleStopDebugging: RequestHandler = async () => {
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    return { stopped: false, message: "No active debug session" };
  }
  try {
    await vscode.debug.stopDebugging(session);
  } catch (err) {
    return {
      stopped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { stopped: true };
};

export function createDebugHandlers(deps: DebugHandlerDeps): {
  handlers: Record<string, RequestHandler>;
  disposeAll: () => void;
} {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.debug.onDidStartDebugSession(() => sendDebugNotification(deps)),
    vscode.debug.onDidTerminateDebugSession(() => sendDebugNotification(deps)),
    vscode.debug.onDidChangeActiveDebugSession(() =>
      sendDebugNotification(deps),
    ),
    vscode.debug.onDidChangeBreakpoints(() => sendDebugNotification(deps)),
  );

  return {
    handlers: {
      "extension/getDebugState": handleGetDebugState,
      "extension/evaluateInDebugger": handleEvaluateInDebugger,
      "extension/setDebugBreakpoints": handleSetDebugBreakpoints,
      "extension/startDebugging": handleStartDebugging,
      "extension/stopDebugging": handleStopDebugging,
    },
    disposeAll() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}
