import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../claude.js";
import { parseSseStream } from "../sse.js";

function stringToStream(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({
    start(controller) {
      // push in two chunks to exercise partial-buffer handling
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
}

describe("parseSseStream", () => {
  it("parses multi-event SSE payload split across chunks", async () => {
    const payload =
      'event: foo\ndata: {"a":1}\n\nevent: bar\ndata: {"b":2}\n\n';
    const events = [];
    for await (const e of parseSseStream(stringToStream(payload))) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: "foo", data: '{"a":1}' });
    expect(events[1]).toEqual({ event: "bar", data: '{"b":2}' });
  });

  it("ignores comment lines and empty events", async () => {
    const payload = ":keepalive\n\nevent: x\ndata: hi\n\n";
    const events = [];
    for await (const e of parseSseStream(stringToStream(payload))) {
      events.push(e);
    }
    expect(events).toEqual([{ event: "x", data: "hi" }]);
  });
});

describe("ClaudeAdapter.stream (SSE)", () => {
  it("emits text deltas + tool call + done", async () => {
    const payload = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"p":"a"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: stringToStream(payload),
      text: async () => "",
    })) as unknown as typeof fetch;

    const a = new ClaudeAdapter({ apiKey: "k", fetchImpl });
    const chunks = [];
    for await (const c of a.stream({
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }

    const textDeltas = chunks.filter((c) => c.type === "text");
    expect(textDeltas.map((c) => (c as { delta: string }).delta)).toEqual([
      "hello",
      " world",
    ]);

    const toolStart = chunks.find((c) => c.type === "tool_call_start");
    expect(toolStart).toMatchObject({ id: "t1", name: "read" });

    const done = chunks.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.result.text).toBe("hello world");
      expect(done.result.toolCalls[0]).toEqual({
        id: "t1",
        name: "read",
        arguments: { p: "a" },
      });
      expect(done.result.stopReason).toBe("tool_use");
      expect(done.result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
      });
    }
  });

  it("surfaces API error in stream", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: null,
      text: async () => "boom",
    })) as unknown as typeof fetch;
    const a = new ClaudeAdapter({ apiKey: "k", fetchImpl });
    const chunks = [];
    for await (const c of a.stream({
      systemPrompt: "",
      messages: [{ role: "user", content: "x" }],
    })) {
      chunks.push(c);
    }
    expect(chunks[0]?.type).toBe("error");
  });
});
