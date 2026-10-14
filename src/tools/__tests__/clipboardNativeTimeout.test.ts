/**
 * The native clipboard fallback must be BOUNDED in time.
 *
 * With no extension connected, readClipboard/writeClipboard shell out to a
 * platform tool (`powershell Get-Clipboard` / `clip` on Windows). A child that
 * never exits — a cold or wedged PowerShell on a loaded Windows runner, or a
 * clipboard held open by another process — used to leave the tool call pending
 * forever, so the MCP client saw no reply at all. Observed as the Windows-only
 * integration failure "Timed out waiting for message" on the readClipboard
 * graceful-error test, failing all three retries.
 *
 * Here the child is mocked to hang; the tool must still answer, and must kill
 * the child rather than leak it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kill = vi.fn();
const stdinEnd = vi.fn();

vi.mock("node:child_process", () => ({
  // Never invokes its callback: a child process that never exits.
  execFile: vi.fn(() => ({ kill, stdin: { end: stdinEnd } })),
}));

const { createReadClipboardTool, createWriteClipboardTool } = await import(
  "../clipboard.js"
);

const disconnected = { isConnected: () => false } as any;
const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** Run `p` while advancing fake time; report whether it settled in `ms`. */
async function settlesWithin<T>(p: Promise<T>, ms: number) {
  let settled = false;
  let value: T | undefined;
  p.then((v) => {
    settled = true;
    value = v;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return { settled, value };
}

beforeEach(() => {
  vi.useFakeTimers();
  kill.mockClear();
  stdinEnd.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

describe.each([
  "win32",
  "darwin",
  "linux",
] as const)("native clipboard fallback on %s — hung child process", (platform) => {
  it("readClipboard answers with a clipboard error instead of hanging", async () => {
    setPlatform(platform);
    const tool = createReadClipboardTool(disconnected);
    // Linux tries xclip then xsel, so allow two timeouts.
    const { settled, value } = await settlesWithin(tool.handler(), 10_000);
    expect(settled).toBe(true);
    expect(value?.isError).toBe(true);
    expect(value?.content[0]?.text.toLowerCase()).toContain("clipboard");
    expect(kill).toHaveBeenCalled();
  });

  it("writeClipboard answers instead of hanging", async () => {
    setPlatform(platform);
    const tool = createWriteClipboardTool(disconnected);
    const { settled, value } = await settlesWithin(
      tool.handler({ text: "hello" }),
      10_000,
    );
    expect(settled).toBe(true);
    expect(value?.isError).toBe(true);
    expect(kill).toHaveBeenCalled();
  });
});
