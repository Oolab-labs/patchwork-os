import type { Socket } from "node:net";
import { WebSocket } from "ws";
import type { Logger } from "./logger.js";

export const BACKPRESSURE_THRESHOLD = 1_048_576; // 1MB — pause sending until drained
export const DRAIN_TIMEOUT_MS = 15_000; // Don't wait forever for drain

/** Wait for the WebSocket send buffer to drain below threshold */
export function waitForDrain(ws: WebSocket, logger: Logger, label = "Backpressure"): Promise<void> {
  if (ws.bufferedAmount < BACKPRESSURE_THRESHOLD) {
    return Promise.resolve();
  }
  logger.warn(`${label}: waiting for drain (buffered: ${ws.bufferedAmount} bytes)`);
  return new Promise<void>((resolve) => {
    const raw = (ws as unknown as { _socket?: Socket })._socket;
    if (!raw) {
      resolve();
      return;
    }
    raw.setMaxListeners(Math.max(raw.getMaxListeners(), 20));
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimeout);
      raw.removeListener("drain", onDrain);
      raw.removeListener("close", onClose);
      resolve();
    };
    const onDrain = () => settle();
    const onClose = () => settle();
    const drainTimeout = setTimeout(() => {
      logger.warn(`${label}: waitForDrain timed out`);
      settle();
    }, DRAIN_TIMEOUT_MS);
    raw.once("drain", onDrain);
    raw.once("close", onClose);
  });
}

/** Send a JSON-RPC message with backpressure awareness.
 *  Returns false if the message was not sent (socket not open). */
export async function safeSend(ws: WebSocket, data: string, logger: Logger): Promise<boolean> {
  if (ws.readyState !== WebSocket.OPEN) return false;
  await waitForDrain(ws, logger);
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(data);
    return true;
  } catch (err) {
    logger.error(`Failed to send: ${err}`);
    return false;
  }
}
