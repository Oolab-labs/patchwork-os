import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { respond500 } from "../httpErrorResponse.js";

interface MockRes {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
}

function makeRes(opts: Partial<MockRes> = {}): MockRes & ServerResponse {
  const res: MockRes = {
    headersSent: false,
    writableEnded: false,
    ...opts,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  };
  return res as MockRes & ServerResponse;
}

describe("respond500", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    stderr?.mockRestore();
  });

  it("writes a generic body even when err is a real Error with a sensitive message", () => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    const err = new Error("DB password was rotated yesterday: hunter2");
    respond500(res, err);
    expect(res.statusCode).toBe(500);
    expect(res.headers).toEqual({ "Content-Type": "application/json" });
    expect(res.body).toBe('{"error":"Internal server error"}');
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("DB password");
  });

  it("works for non-Error throws (string, undefined, plain object)", () => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrown of ["raw string", undefined, { code: "X" }]) {
      const res = makeRes();
      respond500(res, thrown);
      expect(res.body).toBe('{"error":"Internal server error"}');
      expect(res.statusCode).toBe(500);
    }
  });

  it("logs the underlying detail (stack preferred over message) to stderr", () => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    const err = new Error("boom");
    respond500(res, err, "connectors/jira/connect");
    expect(stderr).toHaveBeenCalledTimes(1);
    const firstCall = stderr.mock.calls[0];
    if (!firstCall) throw new Error("expected stderr call");
    const logged = firstCall[0] as string;
    expect(logged).toContain("[http-500] connectors/jira/connect:");
    // Stack format guarantees the message appears too
    expect(logged).toContain("boom");
  });

  it("does not double-write headers when headersSent is already true", () => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes({ headersSent: true, statusCode: 200 });
    respond500(res, new Error("late failure"));
    // statusCode unchanged because writeHead was skipped
    expect(res.statusCode).toBe(200);
    // body still gets written so the connection terminates cleanly
    expect(res.body).toBe('{"error":"Internal server error"}');
  });

  it("does not double-end when writableEnded is already true", () => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes({ headersSent: true, writableEnded: true });
    const endSpy = vi.spyOn(res, "end");
    respond500(res, new Error("after end"));
    expect(endSpy).not.toHaveBeenCalled();
  });
});
