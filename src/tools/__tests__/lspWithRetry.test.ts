import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { lspWithRetry } from "../lsp.js";

describe("lspWithRetry", () => {
  it("returns result immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue({ found: true });
    const result = await lspWithRetry(fn);
    expect(result).toEqual({ found: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns null (not-found) on first call returning null", async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const result = await lspWithRetry(fn);
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates non-timeout errors immediately without retrying", async () => {
    const boom = new Error("network dropped");
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(lspWithRetry(fn)).rejects.toThrow("network dropped");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns timeout sentinel after exhausting all retries", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValue(new ExtensionTimeoutError("cold start"));

    const promise = lspWithRetry(fn);
    // advance past both retry delays (4s + 8s)
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await promise;

    expect(result).toBe("timeout");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("succeeds on third attempt after two timeouts", async () => {
    vi.useFakeTimers();
    const success = { symbols: ["foo"] };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ExtensionTimeoutError("cold"))
      .mockRejectedValueOnce(new ExtensionTimeoutError("cold"))
      .mockResolvedValueOnce(success);

    const promise = lspWithRetry(fn);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await promise;

    expect(result).toEqual(success);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("returns timeout sentinel early when signal is already aborted before retry wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    const fn = vi
      .fn()
      .mockRejectedValue(new ExtensionTimeoutError("cold start"));

    const promise = lspWithRetry(fn, controller.signal);
    // No need to advance timers — aborted signal short-circuits immediately
    const result = await promise;

    expect(result).toBe("timeout");
    // fn called once (attempt 1), abort detected before attempt 2
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("returns timeout sentinel when signal is aborted mid-wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi
      .fn()
      .mockRejectedValue(new ExtensionTimeoutError("cold start"));

    const promise = lspWithRetry(fn, controller.signal);

    // Advance partially into the 4s delay, then abort
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await promise;
    expect(result).toBe("timeout");
    // fn was called once; mid-wait abort means no retry attempt
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
