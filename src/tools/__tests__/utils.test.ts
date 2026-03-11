import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
} from "../utils.js";

describe("resolveFilePath", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "test-workspace-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("resolves absolute paths within workspace", () => {
    const filePath = path.join(workspace, "file.ts");
    fs.writeFileSync(filePath, "");
    expect(resolveFilePath(filePath, workspace)).toBe(filePath);
  });

  it("resolves relative paths within workspace", () => {
    const srcFile = path.join(workspace, "src", "file.ts");
    fs.writeFileSync(srcFile, "");
    expect(resolveFilePath("src/file.ts", workspace)).toBe(srcFile);
  });

  it("rejects paths that escape the workspace via ..", () => {
    expect(() => resolveFilePath("../outside.ts", workspace)).toThrow(
      "escapes workspace",
    );
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => resolveFilePath("/etc/passwd", workspace)).toThrow(
      "escapes workspace",
    );
  });

  it("rejects paths containing null bytes", () => {
    expect(() => resolveFilePath("file\x00.ts", workspace)).toThrow(
      "null bytes",
    );
  });

  it("rejects non-string filePath", () => {
    expect(() => resolveFilePath(123 as unknown as string, workspace)).toThrow(
      "must be a string",
    );
  });

  it("prevents workspace prefix bypass (e.g., workspace-evil)", () => {
    const evilDir = `${workspace}-evil`;
    fs.mkdirSync(evilDir, { recursive: true });
    try {
      expect(() =>
        resolveFilePath(path.join(evilDir, "file.ts"), workspace),
      ).toThrow("escapes workspace");
    } finally {
      fs.rmSync(evilDir, { recursive: true, force: true });
    }
  });
});

describe("requireString", () => {
  it("returns a valid string", () => {
    expect(requireString({ key: "value" }, "key")).toBe("value");
  });

  it("throws on missing key", () => {
    expect(() => requireString({}, "key")).toThrow("must be a string");
  });

  it("throws on non-string value", () => {
    expect(() => requireString({ key: 123 }, "key")).toThrow(
      "must be a string",
    );
  });

  it("throws on null", () => {
    expect(() => requireString({ key: null }, "key")).toThrow(
      "must be a string",
    );
  });

  it("throws when value exceeds maxLength", () => {
    expect(() => requireString({ key: "a".repeat(100) }, "key", 50)).toThrow(
      "exceeds maximum length",
    );
  });
});

describe("optionalString", () => {
  it("returns undefined for missing key", () => {
    expect(optionalString({}, "key")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(optionalString({ key: null }, "key")).toBeUndefined();
  });

  it("returns a valid string", () => {
    expect(optionalString({ key: "val" }, "key")).toBe("val");
  });

  it("throws on non-string value", () => {
    expect(() => optionalString({ key: 42 }, "key")).toThrow(
      "must be a string",
    );
  });
});

describe("optionalInt", () => {
  it("returns undefined for missing key", () => {
    expect(optionalInt({}, "key")).toBeUndefined();
  });

  it("returns a valid integer", () => {
    expect(optionalInt({ key: 5 }, "key")).toBe(5);
  });

  it("throws on float", () => {
    expect(() => optionalInt({ key: 1.5 }, "key")).toThrow(
      "must be an integer",
    );
  });

  it("throws on string", () => {
    expect(() => optionalInt({ key: "5" }, "key")).toThrow(
      "must be an integer",
    );
  });

  it("throws when below min", () => {
    expect(() => optionalInt({ key: 0 }, "key")).toThrow("must be an integer");
  });

  it("throws when above max", () => {
    expect(() => optionalInt({ key: 20_000_000 }, "key")).toThrow(
      "must be an integer",
    );
  });
});

describe("optionalBool", () => {
  it("returns undefined for missing key", () => {
    expect(optionalBool({}, "key")).toBeUndefined();
  });

  it("returns a valid boolean", () => {
    expect(optionalBool({ key: true }, "key")).toBe(true);
  });

  it("throws on non-boolean", () => {
    expect(() => optionalBool({ key: "true" }, "key")).toThrow(
      "must be a boolean",
    );
  });
});
