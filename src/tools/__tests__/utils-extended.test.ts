import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSafe, requireInt, toFileUri, truncateOutput } from "../utils.js";

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
