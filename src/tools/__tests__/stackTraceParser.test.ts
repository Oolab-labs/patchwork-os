import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStackTrace, resolveFrameFile } from "../stackTraceParser.js";

describe("parseStackTrace", () => {
  it("parses Node V8 `at fn (path:L:C)`", () => {
    const trace = `Error: bang
    at Object.doThing (/abs/repo/src/a.ts:42:13)
    at doOther (/abs/repo/src/b.ts:7:3)`;
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      function: "Object.doThing",
      file: "/abs/repo/src/a.ts",
      line: 42,
      column: 13,
      language: "node",
    });
    expect(frames[1]?.function).toBe("doOther");
  });

  it("parses Node bare `at path:L:C`", () => {
    const trace = `    at /abs/repo/src/x.ts:99:2`;
    const frames = parseStackTrace(trace);
    expect(frames[0]).toMatchObject({
      file: "/abs/repo/src/x.ts",
      line: 99,
      column: 2,
      function: null,
      language: "node",
    });
  });

  it("parses Python tracebacks", () => {
    const trace = `Traceback (most recent call last):
  File "/abs/repo/app.py", line 123, in handler
    raise ValueError("x")
ValueError: x`;
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      file: "/abs/repo/app.py",
      line: 123,
      function: "handler",
      language: "python",
    });
  });

  it("parses Firefox/Safari `fn@url:L:C`", () => {
    const trace = `handler@http://localhost:3000/bundle.js:500:17
render@http://localhost:3000/bundle.js:210:5`;
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      function: "handler",
      file: "http://localhost:3000/bundle.js",
      line: 500,
      column: 17,
      language: "browser",
    });
  });

  it("dedupes identical frames", () => {
    const trace = `at fn (/a.ts:1:1)\nat fn (/a.ts:1:1)`;
    expect(parseStackTrace(trace)).toHaveLength(1);
  });

  it("preserves top-of-stack order", () => {
    const trace = `Error
    at top (/a.ts:1:1)
    at middle (/b.ts:2:2)
    at bottom (/c.ts:3:3)`;
    const frames = parseStackTrace(trace);
    expect(frames.map((f) => f.function)).toEqual(["top", "middle", "bottom"]);
  });

  it("falls back to generic file:line:col when no known format matches", () => {
    const trace = `some random output\n/repo/file.ts:55:10 something happened`;
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      file: "/repo/file.ts",
      line: 55,
      column: 10,
      language: "generic",
    });
  });

  it("returns empty array on input with no frames", () => {
    expect(parseStackTrace("just a plain log line")).toEqual([]);
    expect(parseStackTrace("")).toEqual([]);
  });
});

describe("resolveFrameFile", () => {
  const ws = "/repo";

  it("passes through absolute paths inside workspace", () => {
    expect(resolveFrameFile(ws, "/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("joins relative paths with workspace", () => {
    expect(resolveFrameFile(ws, "src/a.ts")).toBe(
      path.resolve("/repo/src/a.ts"),
    );
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveFrameFile(ws, "/etc/passwd")).toBeNull();
    expect(resolveFrameFile(ws, "../outside.ts")).toBeNull();
  });

  it("strips URL scheme+host and tries as relative", () => {
    expect(resolveFrameFile(ws, "http://localhost:3000/src/app.js")).toBe(
      path.resolve("/repo/src/app.js"),
    );
  });

  it("strips webpack:// prefix", () => {
    expect(resolveFrameFile(ws, "webpack://app/./src/index.ts")).toBe(
      path.resolve("/repo/src/index.ts"),
    );
  });

  it("returns null for empty input", () => {
    expect(resolveFrameFile(ws, "")).toBeNull();
  });
});
