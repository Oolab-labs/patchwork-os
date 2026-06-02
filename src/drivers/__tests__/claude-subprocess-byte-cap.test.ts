import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", 0);
    return true;
  });
}

let mockChild: MockChild;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      mockChild = new MockChild();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      (mockChild.stdout as { setEncoding?: () => void }).setEncoding = vi.fn();
      (mockChild.stderr as { setEncoding?: () => void }).setEncoding = vi.fn();
      return mockChild;
    }),
  };
});

import { SubprocessDriver } from "../claude/subprocess.js";
import type { ProviderTaskInput } from "../types.js";

const OUTPUT_CAP = 50 * 1024;
// Buffer.toString("utf8") substitutes a 3-byte U+FFFD for the incomplete
// trailing sequence when the cap lands mid-codepoint, so the byte total may
// exceed the cap by up to 2 bytes (replacement char minus the partial bytes
// it stands in for). This is bounded — the bug being fixed is a 3-4x overshoot
// (slice() counts UTF-16 code units), not this single-replacement slack.
const CAP_TOLERANCE = OUTPUT_CAP + 2;

function makeInput(
  overrides: Partial<ProviderTaskInput> = {},
): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: "/tmp/test",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** True if the string contains a lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate — must be followed by a low surrogate
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // valid pair, skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // low surrogate with no preceding high surrogate
      return true;
    }
  }
  return false;
}

describe("SubprocessDriver UTF-8 byte cap", () => {
  let driver: SubprocessDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new SubprocessDriver("claude", "ant", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Bug 1 regression: OUTPUT_CAP is a BYTE budget. Streaming multi-byte CJK /
  // emoji text via String.slice(0, cap) overshoots the cap ~3-4x (slice counts
  // UTF-16 code units, not bytes) and can emit a lone surrogate at the boundary.
  it("caps streamed onChunk output to <= OUTPUT_CAP bytes for multi-byte assistant text and emits no lone surrogate", async () => {
    const chunks: string[] = [];
    // A long run of 3-byte CJK chars: 30,000 chars == 90,000 UTF-8 bytes,
    // comfortably exceeding the 50KB cap. With the byte-safe fix the forwarded
    // bytes must be <= cap; with the buggy slice() they'd be ~90KB.
    const cjk = "中".repeat(30_000);
    const p = driver.run(makeInput({ onChunk: (c) => chunks.push(c) }));
    await new Promise<void>((r) => setTimeout(r, 0));
    mockChild.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: cjk }] },
      })}\n`,
    );
    mockChild.stdout.emit(
      "data",
      `${JSON.stringify({ type: "result", is_error: false, result: cjk })}\n`,
    );
    mockChild.emit("close", 0);
    await p;

    const forwarded = chunks.join("");
    const forwardedBytes = Buffer.byteLength(forwarded, "utf8");
    expect(forwardedBytes).toBeLessThanOrEqual(CAP_TOLERANCE);
    expect(hasLoneSurrogate(forwarded)).toBe(false);
  });

  it("caps emoji (4-byte / surrogate-pair) streamed output to <= OUTPUT_CAP bytes with no lone surrogate at the boundary", async () => {
    const chunks: string[] = [];
    // Emoji are surrogate pairs (2 UTF-16 units, 4 UTF-8 bytes). Use a count
    // whose byte total straddles the cap so the truncation boundary can land
    // mid-codepoint under the buggy slice().
    const emoji = "😀".repeat(20_000); // 80,000 UTF-8 bytes
    const p = driver.run(makeInput({ onChunk: (c) => chunks.push(c) }));
    await new Promise<void>((r) => setTimeout(r, 0));
    mockChild.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: emoji }],
        },
      })}\n`,
    );
    mockChild.stdout.emit(
      "data",
      `${JSON.stringify({ type: "result", is_error: false, result: emoji })}\n`,
    );
    mockChild.emit("close", 0);
    await p;

    const forwarded = chunks.join("");
    expect(Buffer.byteLength(forwarded, "utf8")).toBeLessThanOrEqual(
      CAP_TOLERANCE,
    );
    expect(hasLoneSurrogate(forwarded)).toBe(false);
  });

  it("caps final returned text to <= OUTPUT_CAP bytes (not UTF-16 units)", async () => {
    const cjk = "中".repeat(30_000); // 90,000 UTF-8 bytes
    const p = driver.run(makeInput());
    await new Promise<void>((r) => setTimeout(r, 0));
    mockChild.stdout.emit(
      "data",
      `${JSON.stringify({ type: "result", is_error: false, result: cjk })}\n`,
    );
    mockChild.emit("close", 0);
    const result = await p;

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      CAP_TOLERANCE,
    );
    expect(hasLoneSurrogate(result.text)).toBe(false);
  });
});
