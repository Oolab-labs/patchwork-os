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
  /** Standard LSP relatedInformation — capped at 5 entries in getDiagnostics sanitizer. */
  relatedInformation?: Array<{
    message: string;
    file?: string;
    line?: number;
    column?: number;
  }>;
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

  // Windowed circuit breaker — opens only if ≥3 timeouts occur within 30 seconds.
  // A single slow LSP response no longer trips the breaker; sustained failure does.
  private static readonly CIRCUIT_WINDOW_MS = 30_000;
  private static readonly CIRCUIT_THRESHOLD = 3;
  private extensionSuspendedUntil = 0;
  private extensionFailureTimes: number[] = []; // timestamps of recent timeouts
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

  // LSP readiness state — pushed by extension when language servers finish indexing.
  // Used by lspWithRetry to skip retry delays for languages known to be ready.
  public lspReadyLanguages = new Set<string>();

  // Connection quality — round-trip latency pushed by extension via rttUpdate notification.
  public lastRttMs: number | null = null;

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
      // Null out this.ws *before* rejectAllPending so that any synchronous retry
      // triggered from a reject handler sees "not connected" and backs off,
      // rather than accidentally sending on the old (about-to-be-terminated) socket.
      const oldWs = this.ws;
      this.ws = null;
      this.connected = false;
      this.rejectAllPending("Extension reconnected");
      oldWs.removeAllListeners();
      if (oldWs.readyState === WebSocket.OPEN) {
        oldWs.terminate();
      }
      // Clear stale diagnostics listeners — the old socket's close event will
      // never fire (listeners removed above), so handleDisconnect won't run for
      // it. Without this, stale watchDiagnostics closures accumulate unboundedly
      // across reconnects and fire on every diagnostic update.
      this.diagnosticsListeners.clear();
    }

    this.ws = ws;
    this.connected = true;

    // Don't clear cached diagnostics/selection/file state — extension pushes
    // fresh data on connect, so stale values are harmless for a few seconds.

    // Clear LSP readiness — extension will re-send on reconnect
    this.lspReadyLanguages.clear();

    // Reset circuit breaker — fresh connection deserves a clean slate
    this.extensionSuspendedUntil = 0;
    this.extensionFailureTimes = [];
    this.extensionHalfOpen = false;
    this.lastRttMs = null;

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
      // Clear LSP readiness — language servers may need to re-index after reconnect
      this.lspReadyLanguages.clear();
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
              file:
                typeof diag.file === "string"
                  ? diag.file.slice(0, 4096)
                  : undefined,
              line: typeof diag.line === "number" ? diag.line : undefined,
              column: typeof diag.column === "number" ? diag.column : undefined,
              endLine:
                typeof diag.endLine === "number" ? diag.endLine : undefined,
              endColumn:
                typeof diag.endColumn === "number" ? diag.endColumn : undefined,
              severity:
                typeof diag.severity === "string"
                  ? diag.severity.slice(0, 32)
                  : undefined,
              message:
                typeof diag.message === "string"
                  ? diag.message.slice(0, 4096)
                  : undefined,
              source:
                typeof diag.source === "string"
                  ? diag.source.slice(0, 256)
                  : undefined,
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
          file: p.file.slice(0, 4096),
          startLine: p.startLine,
          endLine: p.endLine,
          startColumn: p.startColumn,
          endColumn: p.endColumn,
          selectedText: p.selectedText.slice(0, 65536),
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
        this.latestActiveFile = p.file.slice(0, 4096);
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
      case "extension/lspReady": {
        const languageId = p.languageId;
        if (typeof languageId !== "string" || languageId.length > 64) {
          this.logger.debug("Ignoring malformed lspReady notification");
          return;
        }
        this.lspReadyLanguages.add(languageId);
        this.logger.info(`LSP ready: ${languageId}`);
        break;
      }
      case "extension/fileSaved":
        this.logger.debug(
          `[extensionClient] received extension/fileSaved for: ${typeof p.file === "string" ? p.file : "(unknown)"}`,
        );
        if (typeof p.file === "string") {
          this.safeCallback(this.onFileChanged, p.file, "save", p.file);
        }
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
      case "extension/rttUpdate": {
        const latencyMs = p.latencyMs;
        if (
          typeof latencyMs === "number" &&
          latencyMs >= 0 &&
          latencyMs < 10_000
        ) {
          this.lastRttMs = latencyMs;
        }
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
    // Half-open: backoff expired but failures still in window — allow one probe through.
    // Only applicable after the circuit has actually opened (extensionSuspendedUntil > 0).
    if (
      this.extensionSuspendedUntil > 0 &&
      this.extensionFailureTimes.length > 0 &&
      !this.extensionHalfOpen
    ) {
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

      // Wire AbortSignal to cancel the pending request.
      // IMPORTANT: pendingRequests.set must happen before addEventListener so that
      // if the signal fires synchronously during addEventListener (or in the tiny
      // window between the two calls), onAbort finds the entry and deletes it
      // cleanly.  Without this ordering the entry would be inserted after onAbort
      // ran, leaving an orphaned entry with no timeout and no resolution path.
      const onAbort = () => {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        settle(() => reject(new Error("Request aborted")));
      };

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

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

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
      // Success — reset circuit breaker and half-open state
      if (this.extensionFailureTimes.length > 0) {
        this.logger.warn("Extension backoff reset — connection recovered");
      }
      this.extensionFailureTimes = [];
      this.extensionSuspendedUntil = 0;
      this.extensionHalfOpen = false;
      return result;
    } catch (err) {
      if (err instanceof ExtensionTimeoutError) {
        this.extensionHalfOpen = false;
        // Sliding window: prune failures older than CIRCUIT_WINDOW_MS, then record this one
        const now = Date.now();
        this.extensionFailureTimes = this.extensionFailureTimes.filter(
          (t) => now - t < ExtensionClient.CIRCUIT_WINDOW_MS,
        );
        this.extensionFailureTimes.push(now);
        const failures = this.extensionFailureTimes.length;
        this.logger.warn(
          `Extension timed out (${failures} failure${failures === 1 ? "" : "s"} in ${ExtensionClient.CIRCUIT_WINDOW_MS / 1_000}s window)`,
        );
        // Only open the circuit after CIRCUIT_THRESHOLD failures in the window.
        // A single slow LSP response no longer trips the breaker.
        if (failures >= ExtensionClient.CIRCUIT_THRESHOLD) {
          // Full jitter (AWS-recommended): random in [1, cap] — prevents rhythmic
          // retry storms when bridge and extension restart simultaneously.
          const capMs = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          const backoffMs = Math.floor(Math.random() * capMs) + 1;
          this.extensionSuspendedUntil = now + backoffMs;
          this.logger.warn(
            `Extension circuit open (${failures} failures) — suspending for ${Math.round(backoffMs / 100) / 10}s`,
          );
          // Fast-fail all other in-flight requests immediately when the circuit
          // opens. Without this, each queued request waits its own REQUEST_TIMEOUT
          // (10s) independently, so a tool handler chaining N extension calls
          // would hang for up to N×10s after the extension becomes unresponsive.
          // The timed-out request itself is already removed from pendingRequests
          // by its timer callback before reaching this catch block, so calling
          // rejectAllPending here cannot double-reject it.
          this.rejectAllPending(
            `Extension circuit open after ${failures} failures — fast-failing pending requests`,
          );
        }
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

  /**
   * Typed shorthand for requestOrNull — returns T | null without an intermediate variable.
   *
   * WARNING: proxy<T> does a BLIND TypeScript cast with no runtime validation.
   * If the extension handler can return a shape that does not match T (including
   * error-object responses like { error: "..." }), use `tryRequest<T>` instead,
   * which detects error-object responses and returns null.
   *
   * This is the root cause of seven latent shape-mismatch bugs fixed in
   * v2.25.18–v2.25.21. Prefer tryRequest for new client methods.
   */
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

  /**
   * Detect an extension error-object response. Extension handlers by convention
   * return `{ error: string }` (sometimes with `success: false`) on failure
   * instead of throwing. This predicate identifies that shape so tryRequest
   * can convert it to null.
   */
  private isErrorResponse(r: unknown): boolean {
    if (r === null || typeof r !== "object") return false;
    const obj = r as Record<string, unknown>;
    if ("error" in obj && typeof obj.error === "string") return true;
    if (obj.success === false && typeof obj.error === "string") return true;
    return false;
  }

  /**
   * Safer shorthand for requestOrNull — converts extension error-object responses
   * (see isErrorResponse) to null so consumers can distinguish "no result" from
   * "corrupt data". Use this for any handler whose success and failure paths
   * return different shapes. Does NOT guarantee the happy-path shape matches T;
   * for that, do a runtime shape check in the client method.
   */
  private async tryRequest<T>(
    method: string,
    params?: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const raw = await this.requestOrNull(method, params, timeout, signal);
    if (this.isErrorResponse(raw)) return null;
    return raw as T | null;
  }

  /**
   * Shape-validated request — handles shape-wrap bugs where the extension
   * handler returns a different structural shape than the client expects
   * (e.g. `{ folders, count }` vs `WorkspaceFolder[]`).
   *
   * Combines error-object detection from tryRequest with a runtime validator.
   * If `validate` returns null, the response shape did not match and the
   * client should return null — preventing silent data corruption downstream.
   *
   * Use for any handler whose success shape is non-trivial. Prefer over
   * proxy<T> when the response is an object with specific required fields.
   */
  private async validatedRequest<T>(
    method: string,
    params: unknown,
    validate: (raw: unknown) => T | null,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const raw = await this.requestOrNull(method, params, timeout, signal);
    if (raw === null) return null;
    if (this.isErrorResponse(raw)) return null;
    return validate(raw);
  }

  async getDiagnostics(file?: string): Promise<Diagnostic[] | null> {
    return this.proxy<Diagnostic[]>("extension/getDiagnostics", { file });
  }

  async getSelection(): Promise<SelectionState | null> {
    // Extension returns { error: "No active editor" } when no editor is active.
    return this.tryRequest<SelectionState>("extension/getSelection");
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

  async closeTab(file: string): Promise<{
    success: boolean;
    promptedToSave?: boolean;
    error?: string;
  } | null> {
    // Extension returns { success: true, promptedToSave } on close,
    // { success: false, error } when the tab cannot be found.
    const result = await this.requestOrNull("extension/closeTab", { file });
    if (result === null || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;
    return {
      success: r.success === true,
      ...(typeof r.promptedToSave === "boolean" && {
        promptedToSave: r.promptedToSave,
      }),
      ...(typeof r.error === "string" && { error: r.error }),
    };
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

  async findImplementations(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/findImplementations",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async goToTypeDefinition(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/goToTypeDefinition",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async goToDeclaration(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/goToDeclaration",
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getCodeActions",
      { file, startLine, startColumn, endLine, endColumn },
      undefined,
      signal,
    );
  }

  async applyCodeAction(
    file: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
    actionTitle: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/applyCodeAction",
      { file, startLine, startColumn, endLine, endColumn, actionTitle },
      undefined,
      signal,
    );
  }

  async previewCodeAction(
    file: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
    actionTitle: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/previewCodeAction",
      { file, startLine, startColumn, endLine, endColumn, actionTitle },
      15_000,
      signal,
    );
  }

  async renameSymbol(
    file: string,
    line: number,
    column: number,
    newName: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Rename can be slow on large projects
    return this.requestOrNull(
      "extension/renameSymbol",
      { file, line, column, newName },
      15_000,
      signal,
    );
  }

  async searchSymbols(
    query: string,
    maxResults?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/searchSymbols",
      { query, maxResults },
      undefined,
      signal,
    );
  }

  async prepareRename(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/prepareRename",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async formatRange(
    file: string,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/formatRange",
      { file, startLine, endLine },
      undefined,
      signal,
    );
  }

  async signatureHelp(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/signatureHelp",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async foldingRanges(file: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestOrNull(
      "extension/foldingRanges",
      { file },
      undefined,
      signal,
    );
  }

  async selectionRanges(
    file: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/selectionRanges",
      { file, line, column },
      undefined,
      signal,
    );
  }

  async watchFiles(id: string, pattern: string): Promise<unknown> {
    return this.requestOrNull("extension/watchFiles", { id, pattern });
  }

  async unwatchFiles(id: string): Promise<unknown> {
    return this.requestOrNull("extension/unwatchFiles", { id });
  }

  async captureScreenshot(): Promise<{
    base64: string;
    mimeType: string;
  } | null> {
    return this.proxy<{ base64: string; mimeType: string }>(
      "extension/captureScreenshot",
    );
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

  async getDocumentSymbols(
    file: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getDocumentSymbols",
      { file },
      undefined,
      signal,
    );
  }

  async getCallHierarchy(
    file: string,
    line: number,
    column: number,
    direction?: string,
    maxResults?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getCallHierarchy",
      { file, line, column, direction, maxResults },
      15_000,
      signal,
    );
  }

  // --- Code Actions (format, fix, organize) ---

  async formatDocument(file: string): Promise<unknown> {
    // Extension returns { error: "..." } when the format command fails.
    // tryRequest unwraps to null so consumers' `!== null` check falls through
    // to their CLI formatter fallback instead of reporting false success.
    return this.tryRequest("extension/formatDocument", { file }, 15_000);
  }

  async fixAllLintErrors(file: string): Promise<unknown> {
    // Extension returns { error: "..." } on command failure. tryRequest
    // unwraps to null so consumers fall through to their CLI fallback.
    return this.tryRequest("extension/fixAllLintErrors", { file }, 15_000);
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/evaluateInDebugger",
      { expression, frameId, context },
      15_000,
      signal,
    );
  }

  async setDebugBreakpoints(
    file: string,
    breakpoints: BreakpointSpec[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/setDebugBreakpoints",
      { file, breakpoints },
      undefined,
      signal,
    );
  }

  async startDebugging(
    configName?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/startDebugging",
      { configName },
      15_000,
      signal,
    );
  }

  async stopDebugging(signal?: AbortSignal): Promise<unknown> {
    return this.requestOrNull(
      "extension/stopDebugging",
      undefined,
      undefined,
      signal,
    );
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getTypeHierarchy",
      { file, line, column, direction, maxResults },
      15_000,
      signal,
    );
  }

  // --- Code Lens ---

  async getCodeLens(file: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestOrNull(
      "extension/getCodeLens",
      { file },
      undefined,
      signal,
    );
  }

  // --- Semantic Tokens ---

  async getSemanticTokens(
    file: string,
    startLine?: number,
    endLine?: number,
    maxTokens?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestOrNull(
      "extension/getSemanticTokens",
      { file, startLine, endLine, maxTokens },
      15_000,
      signal,
    );
  }

  // --- Document Links ---

  async getDocumentLinks(file: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestOrNull(
      "extension/getDocumentLinks",
      { file },
      undefined,
      signal,
    );
  }

  // --- Tasks ---

  async listTasks(type?: string): Promise<unknown> {
    return this.requestOrNull(
      "extension/listTasks",
      type ? { type } : undefined,
      15_000,
    );
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
    // Extension returns { folders: [...], count: N } — unwrap to array.
    // Back-compat with legacy extension versions that returned the array directly.
    return this.validatedRequest<WorkspaceFolder[]>(
      "extension/getWorkspaceFolders",
      undefined,
      (raw) => {
        if (typeof raw === "object" && raw !== null && "folders" in raw) {
          const folders = (raw as { folders: unknown }).folders;
          return Array.isArray(folders) ? (folders as WorkspaceFolder[]) : null;
        }
        return Array.isArray(raw) ? (raw as WorkspaceFolder[]) : null;
      },
    );
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
    const now = Date.now();
    // Prune stale entries so callers always see the active window count,
    // not the raw array which may include expired timestamps.
    const activeFailures = this.extensionFailureTimes.filter(
      (t) => now - t < ExtensionClient.CIRCUIT_WINDOW_MS,
    );
    return {
      suspended: now < this.extensionSuspendedUntil,
      suspendedUntil: this.extensionSuspendedUntil,
      failures: activeFailures.length,
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
