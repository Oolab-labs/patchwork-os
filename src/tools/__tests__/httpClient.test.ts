/**
 * Tests for sendHttpRequest — input validation and SSRF guard (isPrivateHost).
 * No real network calls are made; the SSRF guard fires before any I/O.
 */
import { describe, expect, it } from "vitest";
import { createSendHttpRequestTool } from "../httpClient.js";

const tool = createSendHttpRequestTool();

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("sendHttpRequest — input validation", () => {
  it("rejects unsupported HTTP method", async () => {
    const result = await tool.handler({
      method: "CONNECT",
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/Unsupported method/);
  });

  it("rejects invalid URL", async () => {
    const result = await tool.handler({ method: "GET", url: "not-a-url" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/Invalid URL/);
  });

  it("rejects non-http/https protocol", async () => {
    const result = await tool.handler({
      method: "GET",
      url: "ftp://example.com/file",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/http/i);
  });
});

describe("sendHttpRequest — SSRF guard (isPrivateHost)", () => {
  async function expectBlocked(url: string) {
    const result = await tool.handler({ method: "GET", url });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/private|loopback/i);
  }

  it("blocks localhost", () => expectBlocked("http://localhost/"));
  it("blocks 127.0.0.1", () => expectBlocked("http://127.0.0.1/"));
  it("blocks 10.0.0.1 (RFC 1918)", () => expectBlocked("http://10.0.0.1/"));
  it("blocks 172.16.0.1 (RFC 1918)", () => expectBlocked("http://172.16.0.1/"));
  it("blocks 192.168.1.1 (RFC 1918)", () =>
    expectBlocked("http://192.168.1.1/"));
  it("blocks 169.254.1.1 (link-local)", () =>
    expectBlocked("http://169.254.1.1/"));
  it("blocks ::1 (IPv6 loopback)", () => expectBlocked("http://[::1]/"));
  it("blocks fe80:: (IPv6 link-local)", () =>
    expectBlocked("http://[fe80::1]/"));
  it("blocks 0.0.0.0", () => expectBlocked("http://0.0.0.0/"));
  it("blocks hex-encoded IP (0x7f000001)", () =>
    expectBlocked("http://0x7f000001/"));
  it("blocks 100.64.0.1 (CGNAT / RFC 6598)", () =>
    expectBlocked("http://100.64.0.1/"));
});
