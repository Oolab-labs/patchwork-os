import { describe, expect, it } from "vitest";
import { parseStreamLine, splitLines } from "../streamParser.js";

describe("codex streamParser: parseStreamLine", () => {
  it("parses thread.started and extracts no text", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "t1" });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.event.type).toBe("thread.started");
      expect(parsed.event.thread_id).toBe("t1");
      expect(parsed.text).toBe("");
    }
  });

  it("parses turn.started with no text", () => {
    const parsed = parseStreamLine(JSON.stringify({ type: "turn.started" }));
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect(parsed.text).toBe("");
  });

  it("parses turn.completed and preserves the usage object", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
      },
    });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.event.usage).toEqual({
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
      });
      expect(parsed.text).toBe("");
    }
  });

  it("extracts text from item.completed when item.type is agent_message", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Hello from Codex" },
    });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.text).toBe("Hello from Codex");
    }
  });

  it("does NOT extract text from item.completed for a non-agent_message item (e.g. command execution)", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "i2",
        type: "command_execution",
        command: "ls",
        status: "ok",
      },
    });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect(parsed.text).toBe("");
  });

  it("item.started never carries text, regardless of item.type", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "i3", type: "agent_message" },
    });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect(parsed.text).toBe("");
  });

  it("extracts error text from a message field", () => {
    const line = JSON.stringify({ type: "error", message: "sandbox denied" });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect(parsed.text).toBe("sandbox denied");
  });

  it("falls back to an error field when message is absent", () => {
    const line = JSON.stringify({ type: "error", error: "spawn failed" });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect(parsed.text).toBe("spawn failed");
  });

  it("falls back to stringifying the whole event when an error carries neither known field — never silently drops an error", () => {
    const line = JSON.stringify({ type: "error", code: "E_UNKNOWN" });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.text.length).toBeGreaterThan(0);
      expect(parsed.text).toContain("E_UNKNOWN");
    }
  });

  it("extracts error text from a turn.failed event the same way as an error event", () => {
    const line = JSON.stringify({
      type: "turn.failed",
      message: "model overloaded",
    });
    const parsed = parseStreamLine(line);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect(parsed.text).toBe("model overloaded");
  });

  it("returns a raw line for non-JSON input instead of throwing", () => {
    const parsed = parseStreamLine("not json at all");
    expect(parsed.kind).toBe("raw");
    if (parsed.kind === "raw") expect(parsed.text).toBe("not json at all\n");
  });

  it("returns a raw line for empty-object-adjacent malformed JSON", () => {
    const parsed = parseStreamLine("{type: 'missing quotes'}");
    expect(parsed.kind).toBe("raw");
  });
});

describe("codex streamParser: splitLines", () => {
  it("splits a chunk with multiple complete lines", () => {
    const { lines, remainder } = splitLines("", "line1\nline2\nline3\n");
    expect(lines).toEqual(["line1", "line2", "line3"]);
    expect(remainder).toBe("");
  });

  it("carries a partial final line into the remainder", () => {
    const { lines, remainder } = splitLines("", "line1\npartial");
    expect(lines).toEqual(["line1"]);
    expect(remainder).toBe("partial");
  });

  it("joins a carried-over remainder with the next chunk", () => {
    const first = splitLines("", "partial-sta");
    expect(first.lines).toEqual([]);
    expect(first.remainder).toBe("partial-sta");
    const second = splitLines(first.remainder, "rt\ncomplete\n");
    expect(second.lines).toEqual(["partial-start", "complete"]);
    expect(second.remainder).toBe("");
  });

  it("handles a chunk containing no newline at all", () => {
    const { lines, remainder } = splitLines("", "no newline here");
    expect(lines).toEqual([]);
    expect(remainder).toBe("no newline here");
  });
});
