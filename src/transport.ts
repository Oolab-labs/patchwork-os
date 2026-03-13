import { WebSocket } from "ws";
import type { ActivityLog } from "./activityLog.js";
import { ErrorCodes } from "./errors.js";
import type { Logger } from "./logger.js";
import { BRIDGE_PROTOCOL_VERSION } from "./version.js";
import { BACKPRESSURE_THRESHOLD, safeSend } from "./wsUtils.js";

const TOOL_TIMEOUT_MS = 60_000; // 60s — prevents tools from blocking indefinitely
const MAX_CONCURRENT_TOOLS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX = 200; // max requests per window
const NOTIFICATION_RATE_LIMIT = 500; // max notifications per minute (separate from request limit)
// Supported MCP protocol versions, newest first.
// Extend this array when new protocol versions are ratified; keep oldest supported version last.
const SUPPORTED_VERSIONS = ["2025-11-25"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** If true, this tool requires the VS Code extension and is hidden when it is disconnected */
  extensionRequired?: boolean;
}

export type ProgressFn = (
  progress: number,
  total?: number,
  message?: string,
) => void;

export type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
  progress?: ProgressFn,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

export class McpTransport {
  private tools = new Map<
    string,
    { schema: ToolSchema; handler: ToolHandler; timeoutMs?: number }
  >();
  private readonly serverInfo = {
    name: "claude-ide-bridge",
    version: BRIDGE_PROTOCOL_VERSION,
  };
  private activeWs: WebSocket | null = null;
  private activeListener: ((data: Buffer) => void) | null = null;
  private inFlightControllers = new Map<string | number, AbortController>();
  private initialized = false;
  private activeToolCalls = 0;
  private callCount = 0;
  private errorCount = 0;
  private generation = 0; // incremented on each attach; stale handlers check this
  // Ring buffer for O(1) sliding-window rate limiting — avoids array scan + splice
  private rateLimitBuf = new Float64Array(RATE_LIMIT_MAX); // initialised to 0 (epoch 1970, always outside window)
  private rateLimitHead = 0; // index of oldest entry / next write position
  // Separate lightweight rate limit for notifications (no response sent, so can't use main ring buffer)
  private notifCount = 0;
  private notifWindowStart = 0;

  private activityLog: ActivityLog | null = null;
  private isExtensionConnectedFn: (() => boolean) | null = null;

  constructor(private logger: Logger) {}

  setExtensionConnectedFn(fn: () => boolean): void {
    this.isExtensionConnectedFn = fn;
  }

  setActivityLog(log: ActivityLog): void {
    this.activityLog = log;
  }

  registerTool(
    schema: ToolSchema,
    handler: ToolHandler,
    timeoutMs?: number,
  ): void {
    if (!/^[a-zA-Z0-9_]+$/.test(schema.name)) {
      throw new Error(
        `Invalid tool name "${schema.name}": must contain only letters, digits, and underscores`,
      );
    }
    this.tools.set(schema.name, { schema, handler, timeoutMs });
  }

  detach(): void {
    // Remove listener from old WebSocket to prevent accumulation
    if (this.activeWs && this.activeListener) {
      this.activeWs.removeListener("message", this.activeListener);
      this.activeListener = null;
    }
    // Abort all in-flight tool calls to prevent resource leaks
    for (const [, controller] of this.inFlightControllers) {
      controller.abort();
    }
    this.inFlightControllers.clear();
    this.activeWs = null;
    this.initialized = false;
    this.activeToolCalls = 0;
    this.rateLimitBuf.fill(0);
    this.rateLimitHead = 0;
    this.notifCount = 0;
    this.notifWindowStart = 0;
  }

  getStats(): { callCount: number; errorCount: number } {
    return { callCount: this.callCount, errorCount: this.errorCount };
  }

  attach(ws: WebSocket): void {
    this.activeWs = ws;
    this.initialized = false; // Force re-initialization on every new connection
    const gen = ++this.generation;
    const listener = async (data: Buffer) => {
      // Ignore messages from superseded connections
      if (gen !== this.generation) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString("utf-8"));
      } catch {
        // Malformed JSON — send PARSE_ERROR per JSON-RPC 2.0 spec §5.1
        await safeSend(
          ws,
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: ErrorCodes.PARSE_ERROR,
              message: "Parse error: message is not valid JSON",
            },
          }),
          this.logger,
        );
        return;
      }
      try {
        if (typeof raw !== "object" || raw === null) {
          this.logger.debug("Ignoring non-object JSON-RPC message");
          return;
        }
        if (Array.isArray(raw)) {
          await safeSend(
            ws,
            JSON.stringify([
              {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Batch requests are not supported",
                },
              },
            ]),
            this.logger,
          );
          return;
        }
        const msg = raw as JsonRpcRequest;
        // Sanitize method name before logging to prevent log injection.
        // A malicious client could embed newlines or ANSI codes in the method field.
        const safeMethod = (s: unknown): string =>
          typeof s === "string"
            ? s.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128)
            : String(s);
        this.logger.debug(`<-- ${safeMethod(msg.method)} (id=${msg.id})`);

        if (!msg.method) return;

        // Notifications (no id)
        if (msg.id === undefined || msg.id === null) {
          // Lightweight rate limit for notifications — they have no response channel
          // so they bypass the main ring-buffer rate limiter.
          const nowNotif = Date.now();
          if (nowNotif - this.notifWindowStart >= RATE_LIMIT_WINDOW_MS) {
            this.notifCount = 0;
            this.notifWindowStart = nowNotif;
          }
          this.notifCount++;
          if (this.notifCount > NOTIFICATION_RATE_LIMIT) {
            this.logger.warn(
              `Notification rate limit exceeded (${NOTIFICATION_RATE_LIMIT}/min) — dropping notification`,
            );
            return;
          }

          if (msg.method === "notifications/cancelled") {
            const requestId = (msg.params as { requestId?: string | number })
              ?.requestId;
            if (requestId !== undefined) {
              const controller = this.inFlightControllers.get(requestId);
              if (controller) controller.abort();
            }
          } else if (msg.method === "notifications/initialized") {
            this.initialized = true;
            this.logger.debug("Client initialized");
          }
          return;
        }

        // Rate limiting — O(1) ring buffer sliding window.
        // rateLimitBuf holds the last RATE_LIMIT_MAX timestamps in insertion order.
        // rateLimitHead points to the oldest entry (next write position).
        // If the oldest timestamp is still within the window, all 200 slots are
        // occupied by recent requests → limit exceeded.
        const now = Date.now();
        const oldest = this.rateLimitBuf[this.rateLimitHead]!;
        if (oldest > now - RATE_LIMIT_WINDOW_MS) {
          this.logger.warn(
            `Rate limit exceeded: ${RATE_LIMIT_MAX} requests in ${RATE_LIMIT_WINDOW_MS}ms`,
          );
          await safeSend(
            ws,
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: ErrorCodes.RATE_LIMIT_EXCEEDED,
                message: "Rate limit exceeded — too many requests",
              },
            }),
            this.logger,
          );
          return;
        }
        // Record this timestamp and advance the head pointer
        this.rateLimitBuf[this.rateLimitHead] = now;
        this.rateLimitHead = (this.rateLimitHead + 1) % RATE_LIMIT_MAX;

        let response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id!,
          error: { code: -32603, message: "Internal error" },
        };

        switch (msg.method) {
          case "initialize": {
            const clientParams = msg.params as
              | { protocolVersion?: string }
              | undefined;
            const clientVersion = clientParams?.protocolVersion;
            const negotiatedVersion =
              clientVersion && SUPPORTED_VERSIONS.includes(clientVersion)
                ? clientVersion
                : SUPPORTED_VERSIONS[0]!;
            if (clientVersion && !SUPPORTED_VERSIONS.includes(clientVersion)) {
              this.logger.warn(
                `Client requested unsupported protocol version ${clientVersion}, responding with ${negotiatedVersion}`,
              );
            }
            this.initialized = false; // Reset — waiting for notifications/initialized
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: negotiatedVersion,
                capabilities: {
                  tools: { listChanged: true },
                  logging: {},
                },
                serverInfo: this.serverInfo,
              },
            };
            break;
          }

          case "tools/list": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            const extConnected = this.isExtensionConnectedFn?.() ?? false;
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: Array.from(this.tools.values())
                  .filter((t) => !t.schema.extensionRequired || extConnected)
                  .map((t) => t.schema),
              },
            };
            break;
          }


          case "tools/call": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            // Reject duplicate request IDs — second call would overwrite the first's AbortController
            if (msg.id !== undefined && this.inFlightControllers.has(msg.id)) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32600, message: "Duplicate request ID" },
              };
              break;
            }
            // Concurrent tool-call limit
            if (this.activeToolCalls >= MAX_CONCURRENT_TOOLS) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Too many concurrent tool calls (max ${MAX_CONCURRENT_TOOLS}). Retry after current calls complete.`,
                    },
                  ],
                  isError: true,
                },
              };
              break;
            }

            const params = msg.params as {
              name: string;
              arguments?: unknown;
              _meta?: { progressToken?: string | number };
            };
            const tool = this.tools.get(params.name);
            if (!tool) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.TOOL_NOT_FOUND,
                  message: "Tool not found",
                  data: params.name,
                },
              };
            } else {
              this.callCount++; // Count all invocations, not just successes (BUG-10)
              const startTime = Date.now();
              const callId = Math.random().toString(36).slice(2, 10);
              const callLog = this.logger.child({ tool: params.name, callId });
              let timedOut = false;
              let handlerPromise: Promise<unknown> | null = null;
              try {
                const toolArgs = params.arguments ?? {};
                if (
                  typeof toolArgs !== "object" ||
                  toolArgs === null ||
                  Array.isArray(toolArgs)
                ) {
                  response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                      code: ErrorCodes.INVALID_PARAMS,
                      message: "Tool arguments must be a JSON object",
                    },
                  };
                  break;
                }
                // Guard against oversized argument payloads before they reach tool handlers
                if (JSON.stringify(toolArgs).length > 1_048_576) {
                  response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                      code: ErrorCodes.INVALID_PARAMS,
                      message: "Tool arguments exceed 1 MB size limit",
                    },
                  };
                  break;
                }
                callLog.debug(`Calling tool: ${params.name}`);
                this.logger.event("tool_call", { tool: params.name, callId });
                const controller = new AbortController();
                this.inFlightControllers.set(msg.id, controller);
                // Build progress callback if client provided a valid progressToken.
                // Reject non-primitive tokens to prevent object injection into notifications.
                const rawToken = params._meta?.progressToken;
                const progressToken =
                  typeof rawToken === "string" || typeof rawToken === "number"
                    ? rawToken
                    : undefined;
                const progressFn: ProgressFn | undefined =
                  progressToken !== undefined
                    ? (progress: number, total?: number, message?: string) =>
                        this.sendProgress(
                          ws,
                          progressToken,
                          progress,
                          total,
                          message,
                        )
                    : undefined;
                this.activeToolCalls++;
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                try {
                  handlerPromise = tool.handler(
                    toolArgs as Record<string, unknown>,
                    controller.signal,
                    progressFn,
                  );

                  const effectiveTimeout = tool.timeoutMs ?? TOOL_TIMEOUT_MS;
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                      timedOut = true;
                      controller.abort();
                      reject(
                        new Error(
                          `Tool "${params.name}" timed out after ${effectiveTimeout}ms`,
                        ),
                      );
                    }, effectiveTimeout);
                  });

                  const result = await Promise.race([
                    handlerPromise,
                    timeoutPromise,
                  ]);
                  const durationMs = Date.now() - startTime;
                  this.activityLog?.record(params.name, durationMs, "success");
                  callLog.debug(`Tool completed in ${durationMs}ms`);
                  response = { jsonrpc: "2.0", id: msg.id, result };
                } finally {
                  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                  this.inFlightControllers.delete(msg.id);
                  // Only decrement if we're still on the same generation;
                  // detach() already reset activeToolCalls for new connections.
                  if (gen === this.generation) {
                    this.activeToolCalls = Math.max(
                      0,
                      this.activeToolCalls - 1,
                    );
                  }
                }
              } catch (err: unknown) {
                // MCP spec: tool execution errors are returned as successful
                // JSON-RPC responses with isError: true in the content, NOT as
                // JSON-RPC error responses. This lets the LLM understand and
                // potentially recover from tool failures.
                const message =
                  err instanceof Error ? err.message : String(err);
                callLog.error(`Tool ${params.name} failed: ${message}`);
                this.errorCount++;
                this.activityLog?.record(
                  params.name,
                  Date.now() - startTime,
                  "error",
                  message,
                );
                response = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    content: [{ type: "text", text: message }],
                    isError: true,
                  },
                };

                // Track zombie tool completion after timeout
                if (timedOut && handlerPromise) {
                  handlerPromise
                    .then(() => {
                      this.logger.warn(
                        `Zombie tool "${params.name}" completed ${Date.now() - startTime}ms after start (timed out at ${tool.timeoutMs ?? TOOL_TIMEOUT_MS}ms)`,
                      );
                    })
                    .catch(() => {
                      // Already logged the timeout error above; suppress the zombie's error
                    });
                }
              }
            }
            break;
          }

          case "ping":
            response = { jsonrpc: "2.0", id: msg.id, result: {} };
            break;

          default:
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: ErrorCodes.METHOD_NOT_FOUND,
                message: `Method not found: ${safeMethod(msg.method)}`,
              },
            };
        }

        this.logger.debug(`--> response for ${safeMethod(msg.method)}`);
        const sent = await safeSend(ws, JSON.stringify(response), this.logger);
        if (!sent) {
          this.logger.warn(
            `Response for ${safeMethod(msg.method)} (id=${msg.id}) dropped — socket closed`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to handle message: ${err}`);
      }
    };
    this.activeListener = listener;
    ws.on("message", listener);
  }

  /** Send progress notification for a long-running tool */
  private sendProgress(
    ws: WebSocket,
    progressToken: string | number,
    progress: number,
    total?: number,
    message?: string,
  ): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        ...(total !== undefined && { total }),
        ...(message !== undefined && { message }),
      },
    };
    if (
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < BACKPRESSURE_THRESHOLD
    ) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* best-effort */
      }
    }
  }

  /** Send a server-initiated notification */
  static sendNotification(
    ws: WebSocket,
    method: string,
    params?: unknown,
    logger?: { warn: (msg: string) => void },
  ): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        logger?.warn(`Failed to send notification ${method}: ${err}`);
      }
    }
  }
}
