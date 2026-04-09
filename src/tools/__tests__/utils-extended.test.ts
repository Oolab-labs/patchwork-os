import { describe, expect, it, vi } from "vitest";
import {
  execSafe,
  requireInt,
  successStructured,
  toFileUri,
  truncateOutput,
  withHeartbeat,
} from "../utils.js";

describe("requireInt", () => {
  it("returns a valid integer", () => {
    expect(requireInt({ count: 5 }, "count")).toBe(5);
  });

  it("throws when value is missing", () => {
    expect(() => requireInt({}, "count")).toThrow("must be an integer");
  });

  it("throws when value is not an integer (float)", () => {
    expect(() => requireInt({ count: 1.5 }, "count")).toThrow(
      "must be an integer",
    );
  });

  it("throws when value is a string", () => {
    expect(() => requireInt({ count: "5" }, "count")).toThrow(
      "must be an integer",
    );
  });

  it("throws when value is null", () => {
    expect(() => requireInt({ count: null }, "count")).toThrow(
      "must be an integer",
    );
  });

  it("throws when value is below min", () => {
    expect(() => requireInt({ count: 0 }, "count", 1, 100)).toThrow(
      "must be an integer between 1 and 100",
    );
  });

  it("throws when value is above max", () => {
    expect(() => requireInt({ count: 200 }, "count", 1, 100)).toThrow(
      "must be an integer between 1 and 100",
    );
  });

  it("accepts boundary values (min and max)", () => {
    expect(requireInt({ count: 1 }, "count", 1, 100)).toBe(1);
    expect(requireInt({ count: 100 }, "count", 1, 100)).toBe(100);
  });
});

describe("toFileUri", () => {
  it("converts an absolute path to a valid file:// URI", () => {
    const uri = toFileUri("/Users/test/file.ts");
    expect(uri).toBe("file:///Users/test/file.ts");
  });

  it("encodes special characters in path", () => {
    const uri = toFileUri("/Users/test/my file.ts");
    expect(uri).toContain("file://");
    expect(uri).toContain("my%20file.ts");
  });

  it("handles paths with multiple segments", () => {
    const uri = toFileUri("/a/b/c/d.txt");
    expect(uri).toBe("file:///a/b/c/d.txt");
  });
});

describe("truncateOutput", () => {
  it("returns unchanged string when under limit", () => {
    const result = truncateOutput("hello", 100);
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("returns unchanged string when exactly at limit", () => {
    const str = "hello"; // 5 bytes
    const result = truncateOutput(str, 5);
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("truncates and sets flag when over limit", () => {
    const str = "hello world this is a long string";
    const result = truncateOutput(str, 5);
    expect(result.text.length).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it("handles empty string", () => {
    const result = truncateOutput("", 100);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });
});

describe("successStructured", () => {
  it("returns content array with JSON-stringified text", () => {
    const data = { foo: 1, bar: "baz" };
    const result = successStructured(data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe(JSON.stringify(data));
  });

  it("returns structuredContent equal to the original data", () => {
    const data = { symbols: [], count: 0, source: "lsp" };
    const result = successStructured(data);
    expect(result.structuredContent).toEqual(data);
  });

  it("structuredContent is the same reference as the data", () => {
    const data = { entries: [1, 2, 3] };
    const result = successStructured(data);
    expect(result.structuredContent).toBe(data);
  });

  it("handles null data", () => {
    const result = successStructured(null);
    expect(result.content[0]?.text).toBe("null");
    expect(result.structuredContent).toBeNull();
  });

  it("handles arrays", () => {
    const data = [{ id: 1 }, { id: 2 }];
    const result = successStructured(data);
    expect(result.content[0]?.text).toBe(JSON.stringify(data));
    expect(result.structuredContent).toEqual(data);
  });

  it("text and structuredContent are consistent (structuredContent round-trips through JSON)", () => {
    const data = { available: true, count: 42, tags: ["a", "b"] };
    const result = successStructured(data);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(
      result.structuredContent,
    );
  });
});

describe("execSafe", () => {
  it("runs a real command and returns stdout", async () => {
    const result = await execSafe("node", ["-e", "console.log('hi')"]);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns non-zero exit code for failing commands", async () => {
    const result = await execSafe("node", ["-e", "process.exit(2)"]);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr", async () => {
    const result = await execSafe("node", ["-e", "console.error('oops')"]);
    expect(result.stderr.trim()).toBe("oops");
  });

  it("reports timeout when command exceeds timeout", async () => {
    const result = await execSafe(
      "node",
      ["-e", "setTimeout(() => {}, 5000)"],
      { timeout: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  }, 10000);
});

describe("withHeartbeat", () => {
  it("returns the result of the wrapped function", async () => {
    const result = await withHeartbeat(() => Promise.resolve(42), undefined);
    expect(result).toBe(42);
  });

  it("no-ops when progress is undefined", async () => {
    // Should not throw
    await expect(
      withHeartbeat(() => Promise.resolve("ok"), undefined),
    ).resolves.toBe("ok");
  });

  it("fires progress notifications during execution", async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("done"), 12_000),
    );
    const resultPromise = withHeartbeat(() => slow, progress, {
      intervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(1, 100, "running…");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(progress).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    expect(await resultPromise).toBe("done");
    vi.useRealTimers();
  });

  it("clears the interval when fn resolves", async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const resultPromise = withHeartbeat(
      () => Promise.resolve("fast"),
      progress,
      { intervalMs: 5_000 },
    );
    const result = await resultPromise;
    expect(result).toBe("fast");
    // Advance time — interval should be cleared, no more calls
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it("clears the interval when fn rejects", async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const resultPromise = withHeartbeat(
      () => Promise.reject(new Error("boom")),
      progress,
      { intervalMs: 5_000 },
    );
    await expect(resultPromise).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it("includes custom message in progress calls", async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 6_000));
    const resultPromise = withHeartbeat(() => slow, progress, {
      intervalMs: 5_000,
      message: "running tests…",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(progress).toHaveBeenCalledWith(1, 100, "running tests…");
    await vi.runAllTimersAsync();
    await resultPromise;
    vi.useRealTimers();
  });
});
