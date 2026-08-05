/**
 * Compensation identifiers (#1264).
 *
 * A write tool that discards the id its own connector returned makes the action
 * irreversible for reasons that have nothing to do with the vendor API — the
 * handle a later delete/cancel needs was in hand and thrown away. These are
 * regression tests for two such cases, asserted at the tool boundary because
 * that is where the loss happened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const appendBlock = vi.fn();
const sendMessage = vi.fn();

vi.mock("../../../connectors/notion.js", () => ({
  getNotionConnector: () => ({ appendBlock }),
}));
vi.mock("../../../connectors/telegram.js", () => ({
  getTelegramConnector: () => ({ sendMessage }),
}));

import "../notion.js";
import "../telegram.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("notion.appendBlock", () => {
  it("surfaces the created block ids rather than only a count", async () => {
    appendBlock.mockResolvedValue({
      results: [
        { object: "block", id: "blk_1" },
        { object: "block", id: "blk_2" },
      ],
    });

    const out = await getTool("notion.appendBlock")?.execute(
      ctx({ pageId: "p1", content: "hello" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.blockCount).toBe(2);
    // Without these the append cannot be undone: Notion deletes a block by id,
    // and a count identifies nothing.
    expect(parsed.blockIds).toEqual(["blk_1", "blk_2"]);
  });
});

describe("telegram.send_message", () => {
  it("surfaces the numeric chat id, not just the message id", async () => {
    sendMessage.mockResolvedValue({
      message_id: 55,
      date: 0,
      chat: { id: -100123, type: "group" },
      text: "hi",
    });

    const out = await getTool("telegram.send_message")?.execute(
      // Caller passes an @username; deleteMessage needs the NUMERIC id the API
      // resolved it to, so echoing the input back would not be enough.
      ctx({ chat_id: "@somechannel", text: "hi" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.message_id).toBe(55);
    expect(parsed.chat_id).toBe(-100123);
  });

  it("does not invent a chat id when the API omits one", async () => {
    sendMessage.mockResolvedValue({ message_id: 7, date: 0, text: "x" });

    const out = await getTool("telegram.send_message")?.execute(
      ctx({ chat_id: "123", text: "x" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.message_id).toBe(7);
    // Absent, not guessed from params — a wrong id is worse than a missing one.
    expect(parsed.chat_id).toBeUndefined();
  });
});
