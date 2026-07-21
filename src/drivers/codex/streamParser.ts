/**
 * Shape of a parsed NDJSON event from `codex exec --json`.
 *
 * Event types confirmed via OpenAI's developer docs (developers.openai.com/
 * codex/noninteractive, redirects to learn.chatgpt.com/docs/non-interactive-mode):
 * thread.started, turn.started, turn.completed, turn.failed, item.started,
 * item.completed, error. The final agent response text lives in an
 * item.completed event whose item.type === "agent_message" — NOT at the
 * top level of the event, unlike Claude's stream-json "result" event.
 *
 * The exact field shape of the `error` and `turn.failed` event types is not
 * documented on the pages fetched — parseStreamLine defensively checks a few
 * plausible field names (`message`, `error`) for both and falls back to
 * stringifying the event so an error is never silently dropped even if the
 * real field name differs.
 */
export interface CodexEvent {
  type:
    | "thread.started"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "item.started"
    | "item.completed"
    | "error"
    | string;
  /** Present on type === "thread.started". */
  thread_id?: string;
  /** Present on type === "turn.completed". */
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  /** Present on type === "item.started" / "item.completed". */
  item?: {
    id?: string;
    type?: string;
    command?: string;
    status?: string;
    /** Present when item.type === "agent_message" on a completed item. */
    text?: string;
  };
  /** Field name unconfirmed for type === "error" — checked defensively. */
  message?: string;
  error?: string;
}

export interface ParsedLine {
  kind: "event";
  event: CodexEvent;
  /** Extracted response/error text for this event, "" if the event carries none. */
  text: string;
}

export interface RawLine {
  kind: "raw";
  text: string;
}

export type ParsedStreamLine = ParsedLine | RawLine;

/**
 * Parse a single NDJSON line from `codex exec --json`. Returns a raw line
 * entry for non-JSON lines (defensive — mirrors the Claude parser's
 * backward-compat handling for unexpected output).
 */
export function parseStreamLine(line: string): ParsedStreamLine {
  try {
    const event = JSON.parse(line) as CodexEvent;
    let text = "";
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      text = typeof event.item.text === "string" ? event.item.text : "";
    } else if (event.type === "error" || event.type === "turn.failed") {
      text =
        typeof event.message === "string"
          ? event.message
          : typeof event.error === "string"
            ? event.error
            : JSON.stringify(event);
    }
    return { kind: "event", event, text };
  } catch {
    return { kind: "raw", text: `${line}\n` };
  }
}

/** Split a chunk into complete lines + a leftover partial. Identical logic to
 * the Claude driver's splitLines (pure, format-agnostic) — kept as a local
 * copy rather than a cross-driver import so codex/ has no dependency on
 * claude/ internals. */
export function splitLines(
  buf: string,
  chunk: string,
): { lines: string[]; remainder: string } {
  const combined = buf + chunk;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  return { lines: parts, remainder };
}
