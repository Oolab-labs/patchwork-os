import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSendHttpRequestTool } from "../httpClient.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function parse(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}) {
  const raw = JSON.parse(result.content.at(0)?.text ?? "{}") as unknown;
  if (
    result.isError &&
    typeof raw === "object" &&
    raw !== null &&
    "error" in (raw as object) &&
    typeof (raw as Record<string, unknown>).error === "string"
  ) {
    return (raw as Record<string, unknown>).error as string;
  }
  return raw;
}

function makeMockResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}): Response {
  const { status = 200, headers = {}, body = "" } = opts;

  const bodyBytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;

  const headersMap = new Headers(headers);

  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: headersMap,
    ok: status >= 200 && status < 300,
    redirected: false,
    url: "https://example.com",
    type: "basic",
    arrayBuffer: vi.fn().mockResolvedValue(bodyBytes.buffer),
    text: vi
      .fn()
      .mockResolvedValue(
        typeof body === "string" ? body : new TextDecoder().decode(body),
      ),
    json: vi.fn(),
    blob: vi.fn(),
    formData: vi.fn(),
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const tool = createSendHttpRequestTool();

describe("sendHttpRequest — Content-Length guard", () => {
  // maxResponseBytes default is 50KB (DEFAULT_RESPONSE_BYTES)
  // MAX_RESPONSE_BYTES hard cap is 1MB
  // We want to test: when Content-Length > maxResponseBytes, the tool rejects
  // without reading the full body (arrayBuffer should NOT be called).

  it("rejects immediately when Content-Length exceeds maxResponseBytes without reading the body", async () => {
    const oversizeBytes = 600 * 1024; // 600 KB — well above default 50 KB
    const mockResp = makeMockResponse({
      status: 200,
      headers: { "content-length": String(oversizeBytes) },
      body: "x".repeat(oversizeBytes),
    });

    mockFetch.mockResolvedValue(mockResp);

    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/bigfile",
    });

    // Should return an error (isError: true)
    expect(result.isError).toBe(true);
    const msg = parse(result);
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/Content-Length|too large|exceeds/i);

    // Critical assertion: arrayBuffer() must NOT have been called —
    // we should not have read the large body into memory.
    expect(mockResp.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects when Content-Length exceeds a user-specified maxResponseBytes", async () => {
    const userMax = 10 * 1024; // 10 KB
    const oversizeBytes = 100 * 1024; // 100 KB
    const mockResp = makeMockResponse({
      status: 200,
      headers: { "content-length": String(oversizeBytes) },
      body: "x".repeat(oversizeBytes),
    });

    mockFetch.mockResolvedValue(mockResp);

    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/bigfile",
      maxResponseBytes: userMax,
    });

    expect(result.isError).toBe(true);
    expect(mockResp.arrayBuffer).not.toHaveBeenCalled();
  });

  it("proceeds normally when Content-Length is within maxResponseBytes", async () => {
    const bodyStr = "Hello, world!";
    const mockResp = makeMockResponse({
      status: 200,
      headers: {
        "content-length": String(bodyStr.length),
        "content-type": "text/plain",
      },
      body: bodyStr,
    });

    mockFetch.mockResolvedValue(mockResp);

    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/smallfile",
    });

    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.status).toBe(200);
    expect(data.body).toBe(bodyStr);

    // arrayBuffer WAS called — body was read normally
    expect(mockResp.arrayBuffer).toHaveBeenCalledOnce();
  });

  it("proceeds normally when Content-Length header is absent (unknown size)", async () => {
    const bodyStr = "some response without content-length";
    const mockResp = makeMockResponse({
      status: 200,
      headers: {}, // no Content-Length
      body: bodyStr,
    });

    mockFetch.mockResolvedValue(mockResp);

    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/streaming",
    });

    expect(result.isError).toBeFalsy();
    const data = parse(result);
    expect(data.status).toBe(200);

    // Without Content-Length we fall through to arrayBuffer (acceptable)
    expect(mockResp.arrayBuffer).toHaveBeenCalledOnce();
  });
});
