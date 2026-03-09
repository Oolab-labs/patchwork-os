import { WebSocket } from "ws";
import type { ActivityLog } from "./activityLog.js";
import { ErrorCodes } from "./errors.js";
import type { Logger } from "./logger.js";
import { safeSend } from "./wsUtils.js";

const TOOL_TIMEOUT_MS = 60_000; // 60s — prevents tools from blocking indefinitely
const MAX_CONCURRENT_TOOLS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX = 200; // max requests per window
const SUPPORTED_VERSIONS = ["2025-11-25"];
const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

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
}

export type ProgressFn = (progress: number, total?: number) => void;

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
  private serverInfo = { name: "claude-ide-bridge", version: "1.1.0" };
  private activeWs: WebSocket | null = null;
  private activeListener: ((data: Buffer) => void) | null = null;
  private inFlightControllers = new Map<string | number, AbortController>();
  private initialized = false;
  private activeToolCalls = 0;
  private messageTimestamps: number[] = [];
  private clientLogLevel: LogLevel = "warning";

  private activityLog: ActivityLog | null = null;

  constructor(private logger: Logger) {}

  setActivityLog(log: ActivityLog): void {
    this.activityLog = log;
  }

  registerTool(schema: ToolSchema, handler: ToolHandler, timeoutMs?: number): void {
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
    this.messageTimestamps = [];
    this.clientLogLevel = "warning";
  }

  attach(ws: WebSocket): void {
    this.activeWs = ws;
    const listener = async (data: Buffer) => {
      // Ignore messages from superseded connections
      if (ws !== this.activeWs) return;
      try {
        const raw: unknown = JSON.parse(data.toString("utf-8"));
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          this.logger.debug("Ignoring non-object JSON-RPC message");
          return;
        }
        const msg = raw as JsonRpcRequest;
        this.logger.debug(`<-- ${msg.method} (id=${msg.id})`);

        if (!msg.method) return;

        // Notifications (no id)
        if (msg.id === undefined || msg.id === null) {
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

        // Rate limiting — sliding window
        const now = Date.now();
        const cutoff = now - RATE_LIMIT_WINDOW_MS;
        if (this.messageTimestamps.length > 0 && this.messageTimestamps[0]! < cutoff) {
          this.messageTimestamps = this.messageTimestamps.filter((t) => t >= cutoff);
        }
        this.messageTimestamps.push(now);
        if (this.messageTimestamps.length > RATE_LIMIT_MAX) {
          this.logger.warn(`Rate limit exceeded: ${this.messageTimestamps.length} requests in ${RATE_LIMIT_WINDOW_MS}ms`);
          await safeSend(ws, JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: ErrorCodes.INTERNAL_ERROR, message: "Rate limit exceeded — too many requests" },
          }), this.logger);
          return;
        }

        let response: JsonRpcResponse;

        switch (msg.method) {
          case "initialize": {
            const clientParams = msg.params as { protocolVersion?: string } | undefined;
            const clientVersion = clientParams?.protocolVersion;
            const negotiatedVersion = clientVersion && SUPPORTED_VERSIONS.includes(clientVersion)
              ? clientVersion
              : SUPPORTED_VERSIONS[0]!;
            if (clientVersion && !SUPPORTED_VERSIONS.includes(clientVersion)) {
              this.logger.warn(`Client requested unsupported protocol version ${clientVersion}, responding with ${negotiatedVersion}`);
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

          case "tools/list":
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: Array.from(this.tools.values()).map((t) => t.schema),
              },
            };
            break;

          case "logging/setLevel": {
            const levelParam = (msg.params as { level?: string })?.level;
            if (levelParam && LOG_LEVELS.includes(levelParam as LogLevel)) {
              this.clientLogLevel = levelParam as LogLevel;
              this.logger.debug(`Client log level set to: ${levelParam}`);
            }
            response = { jsonrpc: "2.0", id: msg.id, result: {} };
            break;
          }

          case "tools/call": {
            // Concurrent tool-call limit
            if (this.activeToolCalls >= MAX_CONCURRENT_TOOLS) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [{ type: "text", text: `Too many concurrent tool calls (max ${MAX_CONCURRENT_TOOLS}). Retry after current calls complete.` }],
                  isError: true,
                },
              };
              break;
            }

            const params = msg.params as { name: string; arguments?: unknown; _meta?: { progressToken?: string | number } };
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
              const startTime = Date.now();
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
                this.logger.debug(`Calling tool: ${params.name}`);
                this.logger.event("tool_call", { tool: params.name });
                const controller = new AbortController();
                this.inFlightControllers.set(msg.id, controller);
                // Build progress callback if client provided a progressToken
                const progressToken = params._meta?.progressToken;
                const progressFn: ProgressFn | undefined = progressToken !== undefined
                  ? (progress: number, total?: number) => this.sendProgress(ws, progressToken, progress, total)
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
                  this.activityLog?.record(
                    params.name,
                    Date.now() - startTime,
                    "success",
                  );
                  response = { jsonrpc: "2.0", id: msg.id, result };
                } finally {
                  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                  this.inFlightControllers.delete(msg.id);
                  this.activeToolCalls--;
                }
              } catch (err: unknown) {
                // MCP spec: tool execution errors are returned as successful
                // JSON-RPC responses with isError: true in the content, NOT as
                // JSON-RPC error responses. This lets the LLM understand and
                // potentially recover from tool failures.
                const message =
                  err instanceof Error ? err.message : String(err);
                this.logger.error(`Tool ${params.name} failed: ${message}`);
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
                message: `Method not found: ${msg.method}`,
              },
            };
        }

        this.logger.debug(`--> response for ${msg.method}`);
        await safeSend(ws, JSON.stringify(response), this.logger);
      } catch (err) {
        this.logger.error(`Failed to handle message: ${err}`);
      }
    };
    this.activeListener = listener;
    ws.on("message", listener);
  }

  /** Send progress notification for a long-running tool */
  private sendProgress(ws: WebSocket, progressToken: string | number, progress: number, total?: number): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken, progress, ...(total !== undefined && { total }) },
    };
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* best-effort */ }
    }
  }

  /** Send a log message to the MCP client (respects clientLogLevel) */
  sendLogMessage(level: LogLevel, loggerName: string, data: string): void {
    if (!this.activeWs || this.activeWs.readyState !== WebSocket.OPEN) return;
    // Only send if the message level is at or above the client's requested level
    const msgIdx = LOG_LEVELS.indexOf(level);
    const clientIdx = LOG_LEVELS.indexOf(this.clientLogLevel);
    if (msgIdx < clientIdx) return;
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level, logger: loggerName, data },
    };
    try { this.activeWs.send(JSON.stringify(msg)); } catch { /* best-effort */ }
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
