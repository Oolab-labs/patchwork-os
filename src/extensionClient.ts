import { WebSocket } from "ws";
import type { Logger } from "./logger.js";
import { BRIDGE_PROTOCOL_VERSION } from "./version.js";
import { safeSend, waitForDrain } from "./wsUtils.js";

/** Thrown when an extension request times out — distinguishable from "no results" (null). */
export class ExtensionTimeoutError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`Extension request ${method} timed out`);
    this.name = "ExtensionTimeoutError";
    this.method = method;
  }
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

export interface SelectionState {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  selectedText: string;
}

export interface TabInfo {
  filePath: string;
  isActive: boolean;
  isDirty: boolean;
  languageId?: string;
}

export interface AIComment {
  file: string;
  line: number;
  comment: string;
  syntax: string;
  fullLine: string;
  severity?: "fix" | "todo" | "question" | "warn" | "task";
}

export interface DebugState {
  hasActiveSession: boolean;
  sessionId?: string;
  sessionName?: string;
  sessionType?: string;
  isPaused: boolean;
  pausedAt?: { file: string; line: number; column: number };
  callStack?: Array<{
    id: number;
    name: string;
    file: string;
    line: number;
    column: number;
  }>;
  scopes?: Array<{
    name: string;
    variables: Array<{ name: string; value: string; type: string }>;
  }>;
  breakpoints: Array<{
    file: string;
    line: number;
    condition?: string;
    enabled: boolean;
  }>;
}

export interface BreakpointSpec {
  line: number;
  condition?: string;
  logMessage?: string;
  hitCondition?: string;
}

export interface DecorationSpec {
  startLine: number;
  endLine?: number;
  message?: string;
  hoverMessage?: string;
  style: "info" | "warning" | "error" | "focus" | "strikethrough" | "dim";
}

export interface WorkspaceFolder {
  name: string;
  path: string;
  uri: string;
  index: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

const REQUEST_TIMEOUT = 10_000;

export class ExtensionClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 0;

  // Exponential backoff — prevents cascading 10s timeouts when extension is unresponsive
  private extensionSuspendedUntil = 0;
  private extensionFailures = 0;
  private extensionHalfOpen = false;

  // State pushed by extension via notifications
  public latestDiagnostics = new Map<string, Diagnostic[]>();
  public latestSelection: SelectionState | null = null;
  public latestActiveFile: string | null = null;
  public lastDiagnosticsUpdate = 0;

  // AI comment cache (pushed by extension)
  public latestAIComments = new Map<string, AIComment[]>();

  // Debug state (pushed by extension via notifications)
  public latestDebugState: DebugState | null = null;

  // Callbacks for forwarding notifications to Claude Code
  public onDiagnosticsChanged:
    | ((file: string, diagnostics: Diagnostic[]) => void)
    | null = null;
  public onAICommentsChanged: ((comments: AIComment[]) => void) | null = null;
  public onFileChanged:
    | ((id: string, type: string, file: string) => void)
    | null = null;
  public onExtensionDisconnected: (() => void) | null = null;
  public onDebugSessionChanged: ((state: DebugState) => void) | null = null;

  // Listener set for diagnostics (used by watchDiagnostics long-poll)
  private diagnosticsListeners = new Set<
    (file: string, diagnostics: Diagnostic[]) => void
  >();

  constructor(private logger: Logger) {}

  /** Invoke a callback safely — log and swallow errors to prevent bridge crash */
  private safeCallback<T extends (...args: never[]) => void>(
    fn: T | null | undefined,
    ...args: Parameters<T>
  ): void {
    if (!fn) return;
    try {
      fn(...args);
    } catch (err) {
      this.logger.error(
        `Callback error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  handleExtensionConnection(ws: WebSocket): void {
    // Replace existing connection
    if (this.ws) {
      this.logger.info("Replacing existing extension connection");
      this.rejectAllPending("Extension reconnected");
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.terminate();
      }
    }

    this.ws = ws;
    this.connected = true;

    // Don't clear cached diagnostics/selection/file state — extension pushes
    // fresh data on connect, so stale values are harmless for a few seconds.

    // Reset backoff — fresh connection deserves a clean slate
    this.extensionSuspendedUntil = 0;
    this.extensionFailures = 0;
    this.extensionHalfOpen = false;

    this.logger.info("Extension client connected");

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString("utf-8"));

        // Response to our request
        if (msg.id !== undefined && msg.id !== null && !msg.method) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          } else {
            this.logger.debug(
              `Orphaned extension response for id=${msg.id} (likely timed out)`,
            );
          }
          return;
        }

        // Push notification from extension
        if (msg.method) {
          this.handleNotification(msg.method, msg.params);
        }
      } catch (err) {
        this.logger.error(`Extension message parse error: ${err}`);
      }
    });

    // Guard against double close/error cleanup
    let disconnected = false;
    const handleDisconnect = (reason: string) => {
      if (disconnected) return;
      disconnected = true;
      this.connected = false;
      this.ws = null;
      this.rejectAllPending(reason);
      // Clear diagnostics listeners — stale watchDiagnostics closures must not
      // accumulate across reconnects (they hold references to old AbortSignals).
      this.diagnosticsListeners.clear();
      this.logger.info(`Extension disconnected: ${reason}`);
      this.safeCallback(this.onExtensionDisconnected);
    };

    ws.on("close", () => handleDisconnect("Connection closed"));
    ws.on("error", (err) => {
      this.logger.error(`Extension WS error: ${err.message}`);
      // Set disconnected flag before terminate() so any synchronous close event
      // emitted by terminate() sees the guard as already set.
      handleDisconnect(`Error: ${err.message}`);
      ws.terminate();
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (typeof params !== "object" || params === null) {
      this.logger.debug(`Ignoring notification ${method} with invalid params`);
      return;
    }
    const p = params as Record<string, unknown>;
    switch (method) {
      case "extension/diagnosticsChanged": {
        const file = p.file;
        const diagnostics = p.diagnostics;
        if (typeof file !== "string" || !Array.isArray(diagnostics)) {
          this.logger.debug(
            "Ignoring malformed diagnosticsChanged notification",
          );
          return;
        }
        let sanitized: Diagnostic[];
        if (diagnostics.length === 0) {
          this.latestDiagnostics.delete(file);
          sanitized = [];
        } else {
          // Sanitize: extract only known-safe fields to prevent prototype pollution
          // when these objects are later spread or merged.
          const safe = diagnostics.map((d: unknown) => {
            if (typeof d !== "object" || d === null) return d;
            const diag = d as Record<string, unknown>;
            return {
              file: typeof diag.file === "string" ? diag.file : undefined,
              line: typeof diag.line === "number" ? diag.line : undefined,
              column: typeof diag.column === "number" ? diag.column : undefined,
              endLine:
                typeof diag.endLine === "number" ? diag.endLine : undefined,
              endColumn:
                typeof diag.endColumn === "number" ? diag.endColumn : undefined,
              severity:
                typeof diag.severity === "string" ? diag.severity : undefined,
              message:
                typeof diag.message === "string" ? diag.message : undefined,
              source: typeof diag.source === "string" ? diag.source : undefined,
              code:
                typeof diag.code === "string" || typeof diag.code === "number"
                  ? diag.code
                  : undefined,
            };
          });
          sanitized = safe as Diagnostic[];
          this.latestDiagnostics.set(file, sanitized);
          // Cap diagnostics cache at 500 entries
          if (this.latestDiagnostics.size > 500) {
            const firstKey = this.latestDiagnostics.keys().next().value;
            if (firstKey !== undefined) this.latestDiagnostics.delete(firstKey);
          }
        }
        // Update timestamp and forward sanitized data to Claude Code
        this.lastDiagnosticsUpdate = Date.now();
        this.safeCallback(this.onDiagnosticsChanged, file, sanitized);
        for (const fn of [...this.diagnosticsListeners])
          this.safeCallback(fn, file, sanitized);
        break;
      }
      case "extension/selectionChanged": {
        if (
          typeof p.file !== "string" ||
          typeof p.startLine !== "number" ||
          typeof p.endLine !== "number" ||
          typeof p.startColumn !== "number" ||
          typeof p.endColumn !== "number" ||
          typeof p.selectedText !== "string"
        ) {
          this.logger.debug("Ignoring malformed selectionChanged notification");
          return;
        }
        this.latestSelection = {
          file: p.file,
          startLine: p.startLine,
          endLine: p.endLine,
          startColumn: p.startColumn,
          endColumn: p.endColumn,
          selectedText: p.selectedText,
        };
        break;
      }
      case "extension/activeFileChanged": {
        if (typeof p.file !== "string") {
          this.logger.debug(
            "Ignoring malformed activeFileChanged notification",
          );
          return;
        }
        this.latestActiveFile = p.file;
        break;
      }
      case "extension/aiCommentsChanged": {
        const comments = p.comments;
        if (!Array.isArray(comments)) {
          this.logger.debug(
            "Ignoring malformed aiCommentsChanged notification",
          );
          return;
        }
        // Valid severity values — defined once outside the loop.
        const VALID_SEVERITIES = new Set([
          "fix",
          "todo",
          "question",
          "warn",
          "task",
        ]);
        this.latestAIComments.clear();
        for (const c of comments) {
          const entry = c as Record<string, unknown>;
          if (typeof entry.file !== "string") continue;
          // Sanitize: extract only known-safe fields (mirrors diagnostics sanitization)
          // to prevent prototype pollution if the extension sends unexpected properties.
          const safe: AIComment = {
            file: entry.file,
            line: typeof entry.line === "number" ? entry.line : 0,
            comment: typeof entry.comment === "string" ? entry.comment : "",
            syntax: typeof entry.syntax === "string" ? entry.syntax : "",
            fullLine: typeof entry.fullLine === "string" ? entry.fullLine : "",
            ...(typeof entry.severity === "string" &&
              VALID_SEVERITIES.has(entry.severity) && {
                severity: entry.severity as AIComment["severity"],
              }),
          };
          const existing = this.latestAIComments.get(safe.file) || [];
          existing.push(safe);
          this.latestAIComments.set(safe.file, existing);
        }
        // Cap at 200 files
        if (this.latestAIComments.size > 200) {
          const firstKey = this.latestAIComments.keys().next().value;
          if (firstKey !== undefined) this.latestAIComments.delete(firstKey);
        }
        // Collect the sanitized entries from latestAIComments and pass those
        // to the callback — not the raw wire data (BUG-5 fix)
        const sanitizedComments: AIComment[] = [];
        for (const entries of this.latestAIComments.values()) {
          sanitizedComments.push(...entries);
        }
        this.safeCallback(this.onAICommentsChanged, sanitizedComments);
        break;
      }
      case "extension/fileChanged": {
        const id = p.id;
        const type = p.type;
        const file = p.file;
        if (
          typeof id === "string" &&
          typeof type === "string" &&
          typeof file === "string"
        ) {
          this.safeCallback(this.onFileChanged, id, type, file);
        }
        break;
      }
      case "extension/hello": {
        const extVer =
          typeof p.extensionVersion === "string"
            ? p.extensionVersion
            : "unknown";
        this.logger.info(`Extension hello: version=${extVer}`);
        const extMajor = Number.parseInt(extVer.split(".")[0] ?? "", 10);
        const bridgeMajor = Number.parseInt(
          BRIDGE_PROTOCOL_VERSION.split(".")[0] ?? "",
          10,
        );
        if (Number.isNaN(extMajor)) {
          this.logger.debug(
            `Extension version "${extVer}" is not a recognized semver format, skipping version check`,
          );
        } else if (extMajor !== bridgeMajor) {
          this.logger.warn(
            `Extension major version mismatch: bridge=${BRIDGE_PROTOCOL_VERSION}, extension=${extVer}. Consider updating.`,
          );
        }
        break;
      }
      case "extension/fileSaved":
        this.logger.debug(
          `[extensionClient] received extension/fileSaved for: ${typeof p.file === "string" ? p.file : "(unknown)"}`,
        );
        break;
      case "extension/debugSessionChanged": {
        if (typeof p.hasActiveSession !== "boolean") {
          this.logger.debug(
            "Ignoring malformed debugSessionChanged notification",
          );
          return;
        }
        // Extract only known-safe fields rather than casting the raw wire object.
        const raw = p as Record<string, unknown>;
        const state: DebugState = {
          hasActiveSession:
            typeof raw.hasActiveSession === "boolean"
              ? raw.hasActiveSession
              : false,
          isPaused: typeof raw.isPaused === "boolean" ? raw.isPaused : false,
          sessionId:
            typeof raw.sessionId === "string" ? raw.sessionId : undefined,
          sessionName:
            typeof raw.sessionName === "string" ? raw.sessionName : undefined,
          sessionType:
            typeof raw.sessionType === "string" ? raw.sessionType : undefined,
          pausedAt:
            raw.pausedAt &&
            typeof raw.pausedAt === "object" &&
            !Array.isArray(raw.pausedAt)
              ? {
                  file:
                    typeof (raw.pausedAt as Record<string, unknown>).file ===
                    "string"
                      ? ((raw.pausedAt as Record<string, unknown>)
                          .file as string)
                      : "",
                  line:
                    typeof (raw.pausedAt as Record<string, unknown>).line ===
                    "number"
                      ? ((raw.pausedAt as Record<string, unknown>)
                          .line as number)
                      : 0,
                  column:
                    typeof (raw.pausedAt as Record<string, unknown>).column ===
                    "number"
                      ? ((raw.pausedAt as Record<string, unknown>)
                          .column as number)
                      : 0,
                }
              : undefined,
          callStack: Array.isArray(raw.callStack)
            ? (raw.callStack as unknown[]).reduce<
                NonNullable<DebugState["callStack"]>
              >((acc, f) => {
                if (typeof f === "object" && f !== null && !Array.isArray(f)) {
                  const frame = f as Record<string, unknown>;
                  acc.push({
                    id: typeof frame.id === "number" ? frame.id : 0,
                    name: typeof frame.name === "string" ? frame.name : "",
                    file: typeof frame.file === "string" ? frame.file : "",
                    line: typeof frame.line === "number" ? frame.line : 0,
                    column: typeof frame.column === "number" ? frame.column : 0,
                  });
                }
                return acc;
              }, [])
            : undefined,
          scopes: Array.isArray(raw.scopes)
            ? (raw.scopes as unknown[]).reduce<
                NonNullable<DebugState["scopes"]>
              >((acc, s) => {
                if (typeof s === "object" && s !== null && !Array.isArray(s)) {
                  const scope = s as Record<string, unknown>;
                  acc.push({
                    name: typeof scope.name === "string" ? scope.name : "",
                    variables: Array.isArray(scope.variables)
                      ? (scope.variables as unknown[]).reduce<
                          Array<{ name: string; value: string; type: string }>
                        >((vacc, v) => {
                          if (typeof v === "object" && v !== null) {
                            const vv = v as Record<string, unknown>;
                            vacc.push({
                              name: typeof vv.name === "string" ? vv.name : "",
                              value:
                                typeof vv.value === "string" ? vv.value : "",
                              type: typeof vv.type === "string" ? vv.type : "",
                            });
                          }
                          return vacc;
                        }, [])
                      : [],
                  });
                }
                return acc;
              }, [])
            : undefined,
          breakpoints: Array.isArray(raw.breakpoints)
            ? (raw.breakpoints as unknown[]).reduce<
                NonNullable<DebugState["breakpoints"]>
              >((acc, b) => {
                if (typeof b === "object" && b !== null) {
                  const bp = b as Record<string, unknown>;
                  acc.push({
                    file: typeof bp.file === "string" ? bp.file : "",
                    line: typeof bp.line === "number" ? bp.line : 0,
                    condition:
                      typeof bp.condition === "string"
                        ? bp.condition
                        : undefined,
                    enabled:
                      typeof bp.enabled === "boolean" ? bp.enabled : true,
                  });
                }
                return acc;
              }, [])
            : [],
        };
        this.latestDebugState = state;
        this.safeCallback(this.onDebugSessionChanged, state);
        break;
      }
      default:
        this.logger.debug(`Unknown extension notification: ${method}`);
    }
  }

  private static readonly MAX_PENDING_REQUESTS = 100;

  private async request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.pendingRequests.size >= ExtensionClient.MAX_PENDING_REQUESTS) {
      throw new Error(
        `Too many pending extension requests (${ExtensionClient.MAX_PENDING_REQUESTS})`,
      );
    }

    // Exponential backoff — fast-fail if extension is repeatedly timing out
    const now = Date.now();
    if (now < this.extensionSuspendedUntil) {
      throw new ExtensionTimeoutError(method);
    }
    // Half-open: backoff expired but failures recorded — allow one probe through
    if (this.extensionFailures > 0 && !this.extensionHalfOpen) {
      this.extensionHalfOpen = true;
      this.logger.debug(
        `Extension circuit breaker half-open — probing with ${method}`,
      );
    }

    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Extension not connected");
    }
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    // Wait for backpressure to clear before sending
    await waitForDrain(this.ws, this.logger, "Extension backpressure");

    // Re-check after drain wait — socket may have closed or circuit breaker may have tripped
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Extension disconnected during drain wait");
    }
    // NOTE: This guard is the only safety net for requests that disconnect during waitForDrain.
    // At this point the request is not yet in pendingRequests, so rejectAllPending() would not catch it.
    if (Date.now() < this.extensionSuspendedUntil) {
      throw new ExtensionTimeoutError(method);
    }

    const timeout = timeoutMs ?? REQUEST_TIMEOUT;
    const id = this.nextId++;
    if (this.nextId >= Number.MAX_SAFE_INTEGER) this.nextId = 0;
    const inner = new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        signal?.removeEventListener("abort", onAbort);
        this.logger.warn(
          `Extension request ${method} timed out after ${timeout}ms`,
        );
        settle(() => reject(new ExtensionTimeoutError(method)));
      }, timeout);

      // Re-check abort after the async drain wait — signal may have fired during that gap.
      // If already aborted, addEventListener would never fire so we must check here.
      if (signal?.aborted) {
        clearTimeout(timer);
        settle(() => reject(new Error("Request aborted")));
        return;
      }

      // Wire AbortSignal to cancel the pending request
      const onAbort = () => {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        settle(() => reject(new Error("Request aborted")));
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          settle(() => resolve(value));
        },
        reject: (reason: Error) => {
          signal?.removeEventListener("abort", onAbort);
          settle(() => reject(reason));
        },
        timer,
        removeAbortListener: signal
          ? () => signal.removeEventListener("abort", onAbort)
          : undefined,
      });

      const data = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(data);
        } catch (err) {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          settle(() =>
            reject(new Error(`Failed to send extension request: ${err}`)),
          );
        }
      } else {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        settle(() => reject(new Error("Extension disconnected before send")));
      }
    });

    try {
      const result = await inner;
      // Success — reset backoff and half-open state
      if (this.extensionFailures > 0) {
        this.logger.warn("Extension backoff reset — connection recovered");
      }
      this.extensionFailures = 0;
      this.extensionSuspendedUntil = 0;
      this.extensionHalfOpen = false;
      return result;
    } catch (err) {
      if (err instanceof ExtensionTimeoutError) {
        this.extensionHalfOpen = false;
        const failures = ++this.extensionFailures;
        // Full jitter (AWS-recommended): random in [1, cap] — prevents rhythmic
        // retry storms when bridge and extension restart simultaneously.
        const capMs = Math.min(1_000 * 2 ** (failures - 1), 60_000);
        const backoffMs = Math.floor(Math.random() * capMs) + 1;
        this.extensionSuspendedUntil = Date.now() + backoffMs;
        this.logger.warn(
          `Extension timed out (failure #${failures}) — suspending for ${Math.round(backoffMs / 100) / 10}s`,
        );
      }
      throw err;
    }
  }

  /** Like request() but returns null on disconnect instead of rejecting.
   *  ExtensionTimeoutError is NOT caught — callers must handle it to distinguish
   *  timeout from genuine "no results" (null). */
  private async requestOrNull(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(method, params, timeoutMs, signal).catch((err) => {
      if (err instanceof ExtensionTimeoutError) throw err;
      return null;
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /** Typed shorthand for requestOrNull — returns T | null without an intermediate variable */
  private async proxy<T>(
    method: string,
    params?: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    return this.requestOrNull(
      method,
      params,
      timeout,
      signal,
    ) as Promise<T | null>;
  }

  async getDiagnostics(file?: string): Promise<Diagnostic[] | null> {
    return this.proxy<Diagnostic[]>("extension/getDiagnostics", { file });
  }

  async getSelection(): Promise<SelectionState | null> {
    return this.proxy<SelectionState>("extension/getSelection");
  }

  async getOpenFiles(): Promise<TabInfo[] | null> {
    return this.proxy<TabInfo[]>("extension/getOpenFiles");
  }

  async isDirty(file: string): Promise<boolean | null> {
    return this.proxy<boolean>("extension/isDirty", { file });
  }

  async getFileContent(file: string): Promise<unknown> {
    return this.requestOrNull("extension/getFileContent", { file });
  }

  async openFile(file: string, line?: number): Promise<boolean> {
    const result = await this.requestOrNull("extension/openFile", {
      file,
      line,
    });
    return result === true;
  }

  async saveFile(file: string): Promise<boolean> {
    const result = await this.requestOrNull("extension/saveFile", { file });
    return result === true;
  }

  async closeTab(file: string): Promise<boolean> {
    const result = await this.requestOrNull("extension/closeTab", { file });
    return result === true;
  }

  async getAIComments(): Promise<AIComment[] | null> {
    return this.proxy<AIComment[]>("extension/getAIComments");
  }

  // --- LSP Semantic Features ---

  async goToDefinition(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/goToDefinition",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async findReferences(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/findReferences",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async getHover(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getHover",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async getCodeActions(
    file: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ): Promise<unknown> {
    return this.requestOrNull("extension/getCodeActions", {
      file,
      startLine,
      startColumn,
      endLine,
      endColumn,
    });
  }

  async applyCodeAction(
    file: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
    actionTitle: string,
  ): Promise<unknown> {
    return this.requestOrNull("extension/applyCodeAction", {
      file,
      startLine,
      startColumn,
      endLine,
      endColumn,
      actionTitle,
    });
  }

  async renameSymbol(
    file: string,
    line: number,
    column: number,
    newName: string,
  ): Promise<unknown> {
    // Rename can be slow on large projects
    return this.requestOrNull(
      "extension/renameSymbol",
      { file, line, column, newName },
      15_000,
    );
  }

  async searchSymbols(query: string, maxResults?: number): Promise<unknown> {
    return this.requestOrNull("extension/searchSymbols", { query, maxResults });
  }

  async watchFiles(id: string, pattern: string): Promise<unknown> {
    return this.requestOrNull("extension/watchFiles", { id, pattern });
  }

  async unwatchFiles(id: string): Promise<unknown> {
    return this.requestOrNull("extension/unwatchFiles", { id });
  }

  // --- Terminal Features ---

  async listTerminals(): Promise<unknown> {
    return this.requestOrNull("extension/listTerminals");
  }

  async getTerminalOutput(
    name?: string,
    index?: number,
    lines?: number,
  ): Promise<unknown> {
    return this.requestOrNull("extension/getTerminalOutput", {
      name,
      index,
      lines,
    });
  }

  async disposeTerminal(name?: string, index?: number): Promise<unknown> {
    return this.requestOrNull("extension/disposeTerminal", { name, index });
  }

  // --- File Operations ---

  async createFile(
    filePath: string,
    content?: string,
    isDirectory?: boolean,
    overwrite?: boolean,
    openAfterCreate?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/createFile", {
      filePath,
      content,
      isDirectory,
      overwrite,
      openAfterCreate,
    });
  }

  async deleteFile(
    filePath: string,
    recursive?: boolean,
    useTrash?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/deleteFile", {
      filePath,
      recursive,
      useTrash,
    });
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    overwrite?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/renameFile", {
      oldPath,
      newPath,
      overwrite,
    });
  }

  // --- Text Editing ---

  async editText(
    filePath: string,
    edits: unknown[],
    save?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/editText", { filePath, edits, save });
  }

  async replaceBlock(
    filePath: string,
    oldContent: string,
    newContent: string,
    save?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/replaceBlock", {
      filePath,
      oldContent,
      newContent,
      save,
    });
  }

  async getDocumentSymbols(file: string): Promise<unknown> {
    return this.requestOrNull("extension/getDocumentSymbols", { file });
  }

  async getCallHierarchy(
    file: string,
    line: number,
    column: number,
    direction?: string,
    maxResults?: number,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getCallHierarchy",
      { file, line, column, direction, maxResults },
      15_000,
    );
  }

  // --- Code Actions (format, fix, organize) ---

  async formatDocument(file: string): Promise<unknown> {
    return this.requestOrNull("extension/formatDocument", { file }, 15_000);
  }

  async fixAllLintErrors(file: string): Promise<unknown> {
    return this.requestOrNull("extension/fixAllLintErrors", { file }, 15_000);
  }

  async organizeImports(file: string): Promise<unknown> {
    return this.requestOrNull("extension/organizeImports", { file }, 15_000);
  }

  // --- Terminal Control ---

  async createTerminal(
    name?: string,
    cwd?: string,
    env?: Record<string, string>,
    show?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/createTerminal", {
      name,
      cwd,
      env,
      show,
    });
  }

  async sendTerminalCommand(
    text: string,
    name?: string,
    index?: number,
    addNewline?: boolean,
  ): Promise<unknown> {
    return this.requestOrNull("extension/sendTerminalCommand", {
      text,
      name,
      index,
      addNewline,
    });
  }

  async waitForTerminalOutput(
    pattern: string,
    name?: string,
    index?: number,
    timeoutMs?: number,
  ): Promise<unknown> {
    const requestTimeout = (timeoutMs ?? 30_000) + 5_000;
    return this.requestOrNull(
      "extension/waitForTerminalOutput",
      { pattern, name, index, timeoutMs },
      requestTimeout,
    );
  }

  async executeInTerminal(
    command: string,
    name?: string,
    index?: number,
    timeoutMs?: number,
    show?: boolean,
  ): Promise<unknown> {
    // Add 5s overhead beyond the command timeout so the bridge doesn't cut the extension off early
    const requestTimeout = (timeoutMs ?? 30_000) + 5_000;
    return this.requestOrNull(
      "extension/executeInTerminal",
      { command, name, index, timeoutMs, show },
      requestTimeout,
    );
  }

  // --- Debug ---

  async getDebugState(): Promise<DebugState | null> {
    return this.proxy<DebugState>("extension/getDebugState");
  }

  async evaluateInDebugger(
    expression: string,
    frameId?: number,
    context?: string,
  ): Promise<unknown> {
    return this.requestOrNull("extension/evaluateInDebugger", {
      expression,
      frameId,
      context,
    });
  }

  async setDebugBreakpoints(
    file: string,
    breakpoints: BreakpointSpec[],
  ): Promise<unknown> {
    return this.requestOrNull("extension/setDebugBreakpoints", {
      file,
      breakpoints,
    });
  }

  async startDebugging(configName?: string): Promise<unknown> {
    return this.requestOrNull(
      "extension/startDebugging",
      { configName },
      15_000,
    );
  }

  async stopDebugging(): Promise<unknown> {
    return this.requestOrNull("extension/stopDebugging");
  }

  // --- Decorations ---

  async setDecorations(
    id: string,
    file: string,
    decorations: DecorationSpec[],
  ): Promise<unknown> {
    return this.requestOrNull("extension/setDecorations", {
      id,
      file,
      decorations,
    });
  }

  async clearDecorations(id?: string): Promise<unknown> {
    return this.requestOrNull("extension/clearDecorations", { id });
  }

  // --- VS Code Commands ---

  async executeVSCodeCommand(
    command: string,
    args?: unknown[],
  ): Promise<unknown> {
    return this.requestOrNull("extension/executeVSCodeCommand", {
      command,
      args,
    });
  }

  async listVSCodeCommands(filter?: string): Promise<string[] | null> {
    return this.proxy<string[]>("extension/listVSCodeCommands", { filter });
  }

  // --- Workspace Settings ---

  async getWorkspaceSettings(
    section?: string,
    target?: string,
  ): Promise<unknown> {
    return this.requestOrNull("extension/getWorkspaceSettings", {
      section,
      target,
    });
  }

  async setWorkspaceSetting(
    key: string,
    value: unknown,
    target?: string,
  ): Promise<unknown> {
    return this.requestOrNull("extension/setWorkspaceSetting", {
      key,
      value,
      target,
    });
  }

  // --- Clipboard ---

  async readClipboard(): Promise<unknown> {
    return this.requestOrNull("extension/readClipboard");
  }

  async writeClipboard(text: string): Promise<unknown> {
    return this.requestOrNull("extension/writeClipboard", { text });
  }

  // --- Inlay Hints ---

  async getInlayHints(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<unknown> {
    return this.requestOrNull("extension/getInlayHints", {
      file,
      startLine,
      endLine,
    });
  }

  // --- Type Hierarchy ---

  async getTypeHierarchy(
    file: string,
    line: number,
    column: number,
    direction?: string,
    maxResults?: number,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getTypeHierarchy",
      { file, line, column, direction, maxResults },
      15_000,
    );
  }

  // --- Tasks ---

  async listTasks(): Promise<unknown> {
    return this.requestOrNull("extension/listTasks", undefined, 15_000);
  }

  async runTask(
    name: string,
    type?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    const requestTimeout = (timeoutMs ?? 60_000) + 5_000;
    return this.requestOrNull(
      "extension/runTask",
      { name, type, timeoutMs },
      requestTimeout,
    );
  }

  // --- Workspace Folders ---

  async getWorkspaceFolders(): Promise<WorkspaceFolder[] | null> {
    return this.proxy<WorkspaceFolder[]>("extension/getWorkspaceFolders");
  }

  // --- Notebook ---

  async getNotebookCells(file: string): Promise<unknown> {
    return this.requestOrNull("extension/getNotebookCells", { file });
  }

  async runNotebookCell(
    file: string,
    cellIndex: number,
    timeoutMs?: number,
  ): Promise<unknown> {
    const requestTimeout = (timeoutMs ?? 30_000) + 5_000;
    return this.requestOrNull(
      "extension/runNotebookCell",
      { file, cellIndex, timeoutMs },
      requestTimeout,
    );
  }

  async getNotebookOutput(file: string, cellIndex: number): Promise<unknown> {
    return this.requestOrNull("extension/getNotebookOutput", {
      file,
      cellIndex,
    });
  }

  // --- Diagnostics Helpers ---

  getCachedDiagnostics(file?: string): Diagnostic[] {
    if (file) return this.latestDiagnostics.get(file) ?? [];
    return Array.from(this.latestDiagnostics.values()).flat();
  }

  addDiagnosticsListener(
    listener: (file: string, diagnostics: Diagnostic[]) => void,
  ): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  /** Notify the extension about Claude Code connection state changes */
  notifyClaudeConnectionState(
    connected: boolean,
    stats?: { callCount: number; errorCount: number; durationMs: number },
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    void safeSend(
      this.ws,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeConnectionChanged",
        params: { connected, ...(stats !== undefined && { stats }) },
      }),
      this.logger,
    );
  }

  /** Push a Claude task output chunk to the VS Code output channel. Best-effort. */
  notifyTaskOutput(taskId: string, chunk: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    void safeSend(
      this.ws,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeTaskOutput",
        params: { taskId, chunk },
      }),
      this.logger,
    );
  }

  /** Push a Claude task completion status to the VS Code output channel. Best-effort. */
  notifyTaskDone(taskId: string, status: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    void safeSend(
      this.ws,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "bridge/claudeTaskOutput",
        params: { taskId, done: true, status },
      }),
      this.logger,
    );
  }

  getCircuitBreakerState(): {
    suspended: boolean;
    suspendedUntil: number;
    failures: number;
  } {
    return {
      suspended: Date.now() < this.extensionSuspendedUntil,
      suspendedUntil: this.extensionSuspendedUntil,
      failures: this.extensionFailures,
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.ws) {
      // Remove listeners before closing so the async "close" event does not
      // re-trigger handleDisconnect → onExtensionDisconnected during shutdown.
      this.ws.removeAllListeners();
      this.ws.close(1000, "Bridge shutting down");
      this.ws = null;
    }
    this.connected = false;
    this.rejectAllPending("Bridge shutting down");
  }
}
