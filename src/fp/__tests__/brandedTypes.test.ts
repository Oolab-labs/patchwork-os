import { describe, expect, it } from "vitest";
import {
  type AbsPath,
  absPath,
  type FileUri,
  fileUri,
  uriToAbsPath,
} from "../brandedTypes.js";

describe("absPath", () => {
  it("returns the string unchanged for absolute paths", () => {
    const p = absPath("/tmp/foo/bar.ts");
    expect(p).toBe("/tmp/foo/bar.ts");
  });

  it("throws for relative paths", () => {
    expect(() => absPath("relative/path")).toThrow(
      "Expected absolute path, got: relative/path",
    );
  });

  it("throws for bare filename", () => {
    expect(() => absPath("file.ts")).toThrow("Expected absolute path");
  });
});

describe("fileUri", () => {
  it("converts AbsPath to file:// URI", () => {
    const p = absPath("/workspace/src/index.ts");
    const uri = fileUri(p);
    expect(uri).toBe("file:///workspace/src/index.ts");
  });

  it("percent-encodes spaces in paths", () => {
    const p = absPath("/my path/file.ts");
    const uri = fileUri(p);
    expect(uri).toContain("file://");
    expect(uri).toContain("%20");
  });
});

describe("uriToAbsPath", () => {
  it("strips file:// prefix", () => {
    const uri = "file:///workspace/src/index.ts" as FileUri;
    const p = uriToAbsPath(uri);
    expect(p).toBe("/workspace/src/index.ts");
  });

  it("round-trips through fileUri", () => {
    const original = absPath("/workspace/src/utils.ts");
    const uri = fileUri(original);
    const back = uriToAbsPath(uri);
    expect(back).toBe(original);
  });

  it("round-trips paths with spaces", () => {
    const original = absPath("/my path/file.ts");
    const uri = fileUri(original);
    const back = uriToAbsPath(uri);
    expect(back).toBe(original);
  });
});

describe("structural typing — AbsPath assignable to string", () => {
  it("AbsPath is usable as string", () => {
    const p: AbsPath = absPath("/foo/bar");
    const s: string = p; // must compile
    expect(s).toBe("/foo/bar");
  });

  it("FileUri is usable as string", () => {
    const p = absPath("/foo/bar");
    const u: FileUri = fileUri(p);
    const s: string = u;
    expect(s).toBe("file:///foo/bar");
  });
});
