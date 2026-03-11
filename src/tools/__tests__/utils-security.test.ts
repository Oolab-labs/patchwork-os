import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { error, findLineNumber, success } from "../utils.js";

describe("success() and error() format", () => {
  it("success returns compact JSON (no pretty-printing)", () => {
    const result = success({ key: "value", nested: { a: 1 } });
    expect(result.content).toHaveLength(1);
    const text = result.content.at(0)?.text ?? "";
    expect(text).not.toContain("\n");
    expect(text).toBe('{"key":"value","nested":{"a":1}}');
  });

  it("success does not have isError", () => {
    const result = success("ok") as any;
    expect(result.isError).toBeUndefined();
  });

  it("error returns compact JSON with isError: true", () => {
    const result = error("something failed");
    expect(result.isError).toBe(true);
    expect(result.content.at(0)?.text).toBe('"something failed"');
  });

  it("error with object data", () => {
    const result = error({ code: 404, message: "not found" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content.at(0)?.text ?? "{}");
    expect(parsed.code).toBe(404);
  });

  it("success with null", () => {
    expect(success(null).content.at(0)?.text).toBe("null");
  });
});

describe("findLineNumber (async)", () => {
  it("finds text on the correct line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-test-"));
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "line one\nline two\nline three\n");
    try {
      expect(await findLineNumber(file, "line two")).toBe(2);
      expect(await findLineNumber(file, "line one")).toBe(1);
      expect(await findLineNumber(file, "three")).toBe(3);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(tmpDir);
    }
  });

  it("returns null for text not found", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utils-test-"));
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello\nworld\n");
    try {
      expect(await findLineNumber(file, "nonexistent")).toBeNull();
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(tmpDir);
    }
  });

  it("returns null for non-existent file", async () => {
    expect(
      await findLineNumber("/tmp/nonexistent-file-12345.txt", "text"),
    ).toBeNull();
  });
});
