/**
 * Minimal SSE parser — consumes a ReadableStream<Uint8Array> and yields
 * parsed event objects. Handles the subset every mainstream LLM provider
 * emits: `event: <name>\ndata: <json>\n\n`.
 *
 * Not a full RFC-compliant SSE parser (no last-event-id, no retry hint).
 * Good enough for Anthropic, OpenAI, Gemini streaming endpoints.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Events are separated by blank lines (\n\n or \r\n\r\n).
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const evt = parseEventBlock(part);
        if (evt) yield evt;
      }
    }
    const tail = buf.trim();
    if (tail) {
      const evt = parseEventBlock(tail);
      if (evt) yield evt;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1).trimStart();
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
