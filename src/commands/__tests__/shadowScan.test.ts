import { describe, expect, it } from "vitest";
import { parseRunsFile, parseSinceDuration } from "../shadowScan.js";

// ---------------------------------------------------------------------------
// parseSinceDuration
// ---------------------------------------------------------------------------

describe("parseSinceDuration", () => {
  it("parses '24h' to a date ~24 hours ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("24h");
    const after = Date.now();

    const expectedMs = 24 * 3_600_000;
    const lower = before - expectedMs;
    const upper = after - expectedMs;

    expect(result.getTime()).toBeGreaterThanOrEqual(lower - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(upper + 1000);
  });

  it("parses '7d' to a date ~7 days ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("7d");
    const after = Date.now();

    const expectedMs = 7 * 86_400_000;
    const lower = before - expectedMs;
    const upper = after - expectedMs;

    expect(result.getTime()).toBeGreaterThanOrEqual(lower - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(upper + 1000);
  });

  it("parses '1h' to a date ~1 hour ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("1h");
    const after = Date.now();

    const expectedMs = 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it("parses '30d' to a date ~30 days ago", () => {
    const before = Date.now();
    const result = parseSinceDuration("30d");
    const after = Date.now();

    const expectedMs = 30 * 86_400_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it("parses a valid ISO 8601 string directly", () => {
    const iso = "2025-01-15T12:00:00.000Z";
    const result = parseSinceDuration(iso);
    expect(result.toISOString()).toBe(iso);
  });

  it("throws on an invalid string", () => {
    expect(() => parseSinceDuration("not-a-date")).toThrow(
      /Invalid since value/,
    );
  });

  it("handles whitespace-padded relative strings", () => {
    const before = Date.now();
    const result = parseSinceDuration("  24h  ");
    const after = Date.now();
    const expectedMs = 24 * 3_600_000;
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });
});

// ---------------------------------------------------------------------------
// parseRunsFile
// ---------------------------------------------------------------------------

describe("parseRunsFile", () => {
  it("parses valid JSONL into RunRecord array", () => {
    const record1 = {
      id: "r1",
      recipeName: "daily",
      toolName: "getDiagnostics",
      args: { uri: "src/index.ts" },
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const record2 = {
      id: "r2",
      recipeName: "nightly",
      toolName: "deleteFile",
      args: { filePath: "tmp/old.txt" },
      result: { success: true },
      timestamp: "2025-01-15T11:00:00.000Z",
    };
    const content = `${JSON.stringify(record1)}\n${JSON.stringify(record2)}\n`;

    const result = parseRunsFile(content);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject(record1);
    expect(result[1]).toMatchObject(record2);
  });

  it("skips malformed JSON lines gracefully", () => {
    const validRecord = {
      id: "r1",
      recipeName: "daily",
      toolName: "getDiagnostics",
      args: {},
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const content =
      `${JSON.stringify(validRecord)}\n` +
      "this is not valid json\n" +
      `${JSON.stringify({ ...validRecord, id: "r2" })}\n`;

    const result = parseRunsFile(content);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("r1");
    expect(result[1]?.id).toBe("r2");
  });

  it("returns empty array for empty file content", () => {
    expect(parseRunsFile("")).toHaveLength(0);
    expect(parseRunsFile("\n\n\n")).toHaveLength(0);
  });

  it("skips non-object JSON values (strings, numbers, arrays)", () => {
    const content =
      '"just a string"\n' +
      "42\n" +
      "[1, 2, 3]\n" +
      `${JSON.stringify({ id: "r1", recipeName: "x", toolName: "y", args: {}, timestamp: "2025-01-15T00:00:00.000Z" })}\n`;

    const result = parseRunsFile(content);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("r1");
  });

  it("handles JSONL with no trailing newline", () => {
    const record = {
      id: "r1",
      recipeName: "daily",
      toolName: "getDiagnostics",
      args: {},
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const result = parseRunsFile(JSON.stringify(record));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("r1");
  });

  it("preserves all fields including optional result", () => {
    const record = {
      id: "r1",
      recipeName: "daily",
      toolName: "runInTerminal",
      args: { command: "echo hi" },
      result: { stdout: "hi\n", exitCode: 0 },
      timestamp: "2025-01-15T10:00:00.000Z",
    };
    const result = parseRunsFile(`${JSON.stringify(record)}\n`);
    expect(result[0]).toMatchObject(record);
  });
});
