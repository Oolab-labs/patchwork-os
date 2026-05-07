import type { WebSocket } from "ws";

/** Send a JSON-RPC message over a WebSocket. */
export function send(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

/**
 * Assert that no WebSocket message satisfying `predicate` arrives within `timeoutMs`.
 * Resolves if the timeout passes without a match. Rejects if a matching message arrives.
 */
export function assertNoMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve();
    }, timeoutMs);
    const handler = (data: Buffer | string) => {
      const parsed = JSON.parse(data.toString("utf-8"));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        reject(
          new Error(`Unexpected message received: ${JSON.stringify(parsed)}`),
        );
      }
    };
    ws.on("message", handler);
  });
}

/**
 * Loose JSON-RPC response shape used by tests. `result` is `any` so test
 * assertions like `resp.result.tools.find(...)` compile without per-callsite
 * casts; production code should use a proper schema. `error` is narrowly
 * typed because the test assertions on `.error.code` and `.error.message`
 * are uniform across the codebase.
 */
export interface JsonRpcTestResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  // biome-ignore lint/suspicious/noExplicitAny: tests assert nested fields
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

/**
 * Wait for the next WebSocket message that satisfies `predicate`.
 * Rejects with a timeout error if no matching message arrives within `timeoutMs`.
 *
 * Defaults to `JsonRpcTestResponse` so callers can directly do
 * `resp.result.tools` / `resp.error.code` without per-callsite casts.
 * Pass a more specific type as the generic argument if needed.
 */
export function waitFor<T = JsonRpcTestResponse>(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs,
    );
    const handler = (data: Buffer | string) => {
      const parsed = JSON.parse(data.toString("utf-8"));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(parsed as T);
      }
    };
    ws.on("message", handler);
  });
}
