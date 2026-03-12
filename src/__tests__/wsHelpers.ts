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
 * Wait for the next WebSocket message that satisfies `predicate`.
 * Rejects with a timeout error if no matching message arrives within `timeoutMs`.
 */
export function waitFor(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
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
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}
