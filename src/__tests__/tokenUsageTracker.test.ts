import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TokenUsageTracker,
  workspaceToProjectSlug,
} from "../tokenUsageTracker.js";

function makeAssistantLine(opts: {
  id: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        id: opts.id,
        usage: {
          input_tokens: opts.input ?? 0,
          output_tokens: opts.output ?? 0,
          cache_creation_input_tokens: opts.cacheCreate ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
        },
      },
    }) + "\n"
  );
}

describe("workspaceToProjectSlug", () => {
  it("matches Claude Code's path encoding", () => {
    expect(
      workspaceToProjectSlug(
        "/Users/wesh/Documents/Anthropic Workspace/Patchwork OS",
      ),
    ).toBe("-Users-wesh-Documents-Anthropic-Workspace-Patchwork-OS");
  });
});

describe("TokenUsageTracker", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function newTracker(): TokenUsageTracker {
    return new TokenUsageTracker({
      workspace: "/x",
      projectsDir: dir,
      pollIntervalMs: 60_000,
    });
  }

  it("returns zeros when projects dir is missing", () => {
    const t = new TokenUsageTracker({
      workspace: "/x",
      projectsDir: path.join(dir, "missing"),
    });
    t.start();
    expect(t.getTotals()).toEqual({
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      total: 0,
      messages: 0,
    });
    t.stop();
  });

  it("aggregates usage across files and dedupes by message.id", () => {
    fs.writeFileSync(
      path.join(dir, "a.jsonl"),
      makeAssistantLine({ id: "msg_1", input: 10, output: 5 }) +
        makeAssistantLine({ id: "msg_1", input: 10, output: 5 }) +
        makeAssistantLine({ id: "msg_2", input: 3, output: 7, cacheRead: 100 }),
    );
    fs.writeFileSync(
      path.join(dir, "b.jsonl"),
      makeAssistantLine({ id: "msg_3", output: 2, cacheCreate: 50 }),
    );
    const t = newTracker();
    t.start();
    expect(t.getTotals()).toEqual({
      input: 13,
      output: 14,
      cacheCreate: 50,
      cacheRead: 100,
      total: 27,
      messages: 3,
    });
    t.stop();
  });

  it("ignores non-assistant lines and malformed JSON", () => {
    fs.writeFileSync(
      path.join(dir, "x.jsonl"),
      JSON.stringify({ type: "user", message: { id: "u_1" } }) +
        "\n" +
        "not-json\n" +
        makeAssistantLine({ id: "msg_a", input: 1, output: 2 }),
    );
    const t = newTracker();
    t.start();
    expect(t.getTotals().total).toBe(3);
    expect(t.getTotals().messages).toBe(1);
    t.stop();
  });

  it("incrementally picks up appended lines on subsequent scans", () => {
    const file = path.join(dir, "live.jsonl");
    fs.writeFileSync(
      file,
      makeAssistantLine({ id: "m1", input: 1, output: 1 }),
    );
    const t = new TokenUsageTracker({
      workspace: "/x",
      projectsDir: dir,
      pollIntervalMs: 1_000_000,
    });
    t.start();
    expect(t.getTotals().messages).toBe(1);

    fs.appendFileSync(
      file,
      makeAssistantLine({ id: "m2", input: 4, output: 6 }),
    );
    // trigger a manual scan via private method through a fresh start cycle
    t.stop();
    t.start();
    expect(t.getTotals()).toMatchObject({ input: 5, output: 7, messages: 2 });
    t.stop();
  });

  it("handles partial trailing line written across two scans", () => {
    const file = path.join(dir, "partial.jsonl");
    const line = makeAssistantLine({ id: "m_p", input: 2, output: 3 });
    const half = line.slice(0, line.length - 5);
    fs.writeFileSync(file, half);
    const t = newTracker();
    t.start();
    expect(t.getTotals().messages).toBe(0);

    fs.writeFileSync(file, line);
    t.stop();
    t.start();
    expect(t.getTotals().messages).toBe(1);
    expect(t.getTotals().total).toBe(5);
    t.stop();
  });
});
