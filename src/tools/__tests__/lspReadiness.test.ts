import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { lspWithRetry } from "../lsp.js";

describe("lspWithRetry with isLspReady", () => {
  it("skips retries when isLspReady returns true and first call times out", async () => {
    const fn = vi.fn().mockRejectedValue(new ExtensionTimeoutError("getHover"));

    const result = await lspWithRetry(fn, undefined, () => true);

    expect(result).toBe("timeout");
    // Only 1 attempt — no retries since LSP is "ready"
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns result on first success even when isLspReady is true", async () => {
    const fn = vi.fn().mockResolvedValue({ found: true });

    const result = await lspWithRetry(fn, undefined, () => true);

    expect(result).toEqual({ found: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries normally when isLspReady returns false", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ExtensionTimeoutError("getHover"))
      .mockRejectedValueOnce(new ExtensionTimeoutError("getHover"))
      .mockResolvedValueOnce({ found: true });

    const promise = lspWithRetry(fn, undefined, () => false);
    // Advance past 4s delay
    await vi.advanceTimersByTimeAsync(4_000);
    // Advance past 8s delay
    await vi.advanceTimersByTimeAsync(8_000);

    const result = await promise;
    expect(result).toEqual({ found: true });
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("retries normally when isLspReady is undefined", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ExtensionTimeoutError("getHover"))
      .mockResolvedValueOnce({ found: true });

    const promise = lspWithRetry(fn, undefined, undefined);
    await vi.advanceTimersByTimeAsync(4_000);

    const result = await promise;
    expect(result).toEqual({ found: true });
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("returns null on first success even when isLspReady is true (null = no result, not error)", async () => {
    const fn = vi.fn().mockResolvedValue(null);

    const result = await lspWithRetry(fn, undefined, () => true);

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
