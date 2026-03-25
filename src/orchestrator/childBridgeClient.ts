import { randomUUID } from "node:crypto";
import http from "node:http";
import { ErrorCodes } from "../errors.js";
import type { ToolSchema } from "../transport.js";

const TOOL_CALL_TIMEOUT_MS = 90_000;
const PING_TIMEOUT_MS = 2_000;
const INIT_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// Circuit breaker states
type CircuitState = "closed" | "open" | "half_open";
const CIRCUIT_RESET_MS = 5_000;

export class ChildBridgeClient {
  private sessionId: string | null = null;
  private circuitState: CircuitState = "closed";
  private circuitOpenedAt = 0;
  private consecutiveFailures = 0;
  private agent: http.Agent;

  constructor(
    private port: number,
    private authToken: string,
  ) {
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: 4,
      maxFreeSockets: 2,
    });
  }

  get isHealthy(): boolean {
    if (this.circuitState === "open") {
      if (Date.now() - this.circuitOpenedAt >= CIRCUIT_RESET_MS) {
        this.circuitState = "half_open";
      } else {
        return false;
      }
    }
    return true;
  }

  async initSession(): Promise<boolean> {
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "orchestrator-bridge", version: "1.0.0" },
        },
      });

      const res = await this.post(body, INIT_TIMEOUT_MS, null);
      if (!res.ok) {
        this.onFailure();
        return false;
      }

      const sessionId = res.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        this.sessionId = sessionId;
      }

      // Send initialized notification
      const notif = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      await this.post(notif, INIT_TIMEOUT_MS, this.sessionId).catch(() => {});

      this.onSuccess();
      return true;
    } catch {
      this.onFailure();
      return false;
    }
  }

  async listTools(): Promise<ToolSchema[]> {
    if (!this.isHealthy) return [];
    if (!this.sessionId) {
      const ok = await this.initSession();
      if (!ok) return [];
    }

    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/list",
        params: {},
      });

      const res = await this.post(body, INIT_TIMEOUT_MS, this.sessionId);
      if (!res.ok) {
        this.onFailure();
        return [];
      }

      const json = res.body as {
        result?: { tools?: ToolSchema[] };
      };
      this.onSuccess();
      return json.result?.tools ?? [];
    } catch {
      this.onFailure();
      return [];
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.isHealthy) {
      throw bridgeUnavailableError(this.port, "circuit open");
    }

    if (!this.sessionId) {
      const ok = await this.initSession();
      if (!ok) throw bridgeUnavailableError(this.port, "session init failed");
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    });

    try {
      let res = await this.post(
        body,
        TOOL_CALL_TIMEOUT_MS,
        this.sessionId,
        signal,
      );

      // 404 means the child's HTTP session expired (2-hour idle TTL).
      // Re-initialize the session and retry once — this is not a bridge failure.
      if (res.status === 404) {
        this.sessionId = null;
        const ok = await this.initSession();
        if (!ok)
          throw bridgeUnavailableError(
            this.port,
            "session reinit failed after 404",
          );
        res = await this.post(
          body,
          TOOL_CALL_TIMEOUT_MS,
          this.sessionId,
          signal,
        );
      }

      if (!res.ok) {
        this.onFailure();
        throw bridgeUnavailableError(this.port, `HTTP ${res.status}`);
      }

      const json = res.body as {
        result?: {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        error?: { code: number; message: string; data?: unknown };
      };

      if (json.error) {
        // Protocol error from child — propagate as-is
        const err = new Error(json.error.message) as Error & {
          bridgeError: typeof json.error;
        };
        err.bridgeError = json.error;
        throw err;
      }

      this.onSuccess();
      return {
        content: json.result?.content ?? [{ type: "text", text: "" }],
      };
    } catch (err) {
      if ((err as { bridgeError?: unknown }).bridgeError) throw err;
      this.onFailure();
      throw bridgeUnavailableError(
        this.port,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async ping(): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: this.port,
            path: "/ping",
            method: "GET",
            agent: this.agent,
            timeout: PING_TIMEOUT_MS,
          },
          (res) => {
            res.resume();
            if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
              resolve();
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      });
      this.onSuccess();
      return true;
    } catch {
      this.onFailure();
      return false;
    }
  }

  async closeSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: this.port,
            path: "/mcp",
            method: "DELETE",
            headers: {
              "mcp-session-id": this.sessionId ?? "",
              authorization: `Bearer ${this.authToken}`,
            },
            agent: this.agent,
            timeout: 2000,
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", () => resolve());
        req.end();
      });
    } finally {
      this.sessionId = null;
    }
  }

  /** Reset circuit breaker to closed state — call when a warming bridge first becomes healthy. */
  resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
  }

  destroy(): void {
    this.agent.destroy();
  }

  private async post(
    body: string,
    timeoutMs: number,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    headers: http.IncomingHttpHeaders;
    body: unknown;
  }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        authorization: `Bearer ${this.authToken}`,
        accept: "application/json, text/event-stream",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/mcp",
          method: "POST",
          headers,
          agent: this.agent,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf-8");
              // Handle SSE responses — take the last data: line that parses as a
              // JSON-RPC response (has `result` or `error`). Progress notifications
              // arrive before the final result and must be skipped; using the first
              // data: line would return the progress notification as the tool result.
              let json: unknown;
              if (text.startsWith("data:")) {
                let last: unknown = {};
                for (const line of text.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  try {
                    const parsed = JSON.parse(line.slice(5).trim()) as Record<
                      string,
                      unknown
                    >;
                    if ("result" in parsed || "error" in parsed) last = parsed;
                  } catch {
                    // skip unparseable lines
                  }
                }
                json = last;
              } else {
                json = JSON.parse(text || "{}");
              }
              resolve({
                ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: json,
              });
            } catch (err) {
              reject(err);
            }
          });
          res.on("error", reject);
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(
          new Error(`Request to child bridge port ${this.port} timed out`),
        );
      });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            req.destroy();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }

      req.write(body);
      req.end();
    });
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitState === "half_open") {
      this.circuitState = "closed";
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (
      this.circuitState !== "open" &&
      this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
    ) {
      this.circuitState = "open";
      this.circuitOpenedAt = Date.now();
    }
  }
}

export interface BridgeUnavailableError extends Error {
  code: typeof ErrorCodes.BRIDGE_UNAVAILABLE;
  bridgePort: number;
}

function bridgeUnavailableError(
  port: number,
  reason: string,
): BridgeUnavailableError {
  const err = new Error(
    `Child bridge on port ${port} is unavailable: ${reason}`,
  ) as BridgeUnavailableError;
  err.code = ErrorCodes.BRIDGE_UNAVAILABLE;
  err.bridgePort = port;
  return err;
}
