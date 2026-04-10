import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  handleReadClipboard,
  handleWriteClipboard,
} from "../../handlers/clipboard";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

describe("handleReadClipboard", () => {
  it("returns text and byteLength for a short string", async () => {
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue("hello world");
    const result = (await handleReadClipboard()) as any;
    expect(result.text).toBe("hello world");
    expect(result.byteLength).toBe(Buffer.byteLength("hello world", "utf-8"));
  });

  it("sets truncated=false when content is under 100KB", async () => {
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue("short text");
    const result = (await handleReadClipboard()) as any;
    expect(result.truncated).toBe(false);
  });

  it("sets truncated=true and caps text when content is over 100KB", async () => {
    const overLimit = "x".repeat(101 * 1024); // 101 KB
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue(overLimit);
    const result = (await handleReadClipboard()) as any;
    expect(result.truncated).toBe(true);
    // The returned text must be at most 100KB
    expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(
      100 * 1024,
    );
    // The original byteLength is reported accurately
    expect(result.byteLength).toBe(Buffer.byteLength(overLimit, "utf-8"));
  });

  it("returns empty string when clipboard is empty", async () => {
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue("");
    const result = (await handleReadClipboard()) as any;
    expect(result.text).toBe("");
    expect(result.byteLength).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe("handleWriteClipboard", () => {
  it("throws if text param is not a string", async () => {
    await expect(handleWriteClipboard({ text: 42 })).rejects.toThrow(
      "text is required and must be a string",
    );
  });

  it("throws if text param is missing", async () => {
    await expect(handleWriteClipboard({})).rejects.toThrow(
      "text is required and must be a string",
    );
  });

  it("throws if text exceeds 1MB", async () => {
    const tooBig = "a".repeat(1024 * 1024 + 1);
    await expect(handleWriteClipboard({ text: tooBig })).rejects.toThrow(
      "Text too large",
    );
  });

  it("returns {written: true, byteLength} on success", async () => {
    vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);
    const result = (await handleWriteClipboard({ text: "hello" })) as any;
    expect(result.written).toBe(true);
    expect(result.byteLength).toBe(Buffer.byteLength("hello", "utf-8"));
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("returns {written: false, error} when writeText throws", async () => {
    vi.mocked(vscode.env.clipboard.writeText).mockRejectedValue(
      new Error("clipboard access denied"),
    );
    const result = (await handleWriteClipboard({ text: "hello" })) as any;
    expect(result.written).toBe(false);
    expect(result.error).toMatch(/clipboard access denied/);
  });

  it("accepts text exactly at 1MB limit without throwing", async () => {
    const atLimit = "a".repeat(1024 * 1024);
    vi.mocked(vscode.env.clipboard.writeText).mockResolvedValue(undefined);
    const result = (await handleWriteClipboard({ text: atLimit })) as any;
    expect(result.written).toBe(true);
  });
});
