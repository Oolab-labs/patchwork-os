/** Shape of a parsed stream-json event from `claude -p --output-format stream-json`. */
export interface StreamJsonEvent {
  type: "system" | "assistant" | "result" | string;
  /** Present on type === "assistant" */
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  /** Present on type === "result" — canonical full response text. */
  result?: string;
  /** Present on type === "result" — true when claude hit an error (e.g. max_turns). */
  is_error?: boolean;
  /** Present on type === "system" — session identifier. */
  session_id?: string;
}

export interface ParsedLine {
  kind: "event";
  event: StreamJsonEvent;
  text: string;
}

export interface RawLine {
  kind: "raw";
  text: string;
}

export type ParsedStreamLine = ParsedLine | RawLine;

/**
 * Parse a single JSONL line from the stream-json output format.
 * Returns a raw line entry for non-JSON lines (backward compat with old binaries).
 */
export function parseStreamLine(line: string): ParsedStreamLine {
  try {
    const event = JSON.parse(line) as StreamJsonEvent;
    let text = "";
    if (event.type === "assistant") {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        text = content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
      }
    } else if (event.type === "result") {
      text = typeof event.result === "string" ? event.result : "";
    }
    return { kind: "event", event, text };
  } catch {
    return { kind: "raw", text: `${line}\n` };
  }
}

/** Split a chunk into complete lines + a leftover partial. */
export function splitLines(
  buf: string,
  chunk: string,
): { lines: string[]; remainder: string } {
  const combined = buf + chunk;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  return { lines: parts, remainder };
}
