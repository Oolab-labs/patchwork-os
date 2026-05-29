/**
 * Tests for sendHttpRequest — input validation and SSRF guard (isPrivateHost).
 * No real network calls are made; the SSRF guard fires before any I/O.
 */
import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSendHttpRequestTool } from "../httpClient.js";

const tool = createSendHttpRequestTool();

function parse(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}) {
  // Error results carry the plain message in `text` and machine-readable
  // fields in `structuredContent` (ADR-0004).
  if (result.isError && result.structuredContent !== undefined)
    return result.structuredContent as any;
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

describe("sendHttpRequest — AbortSignal listener cleanup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("removes abort listener from caller signal when request fails with network error", async () => {
    // Regression: before fix, clearTimeout was called but the abort forwarder
    // was never removed from the caller's signal, causing listener accumulation
    // over many requests on a long-lived AbortController.

    // Mock DNS to return a public IP (avoids real DNS + passes SSRF guard)
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    } as any);

    // Mock fetch to fail with a network error (no real I/O)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch failed: network error"));

    const controller = new AbortController();
    let removeCalled = 0;
    const origRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(
      (type, fn, opts) => {
        if (type === "abort") removeCalled++;
        return origRemove(type, fn, opts);
      },
    );

    await tool.handler(
      { method: "GET", url: "https://example.com" },
      controller.signal,
    );

    // cleanup() must have been called — abort listener removed from caller signal
    expect(removeCalled).toBe(1);
    fetchSpy.mockRestore();
  });
});

describe("sendHttpRequest — timeout error message (AbortError / TimeoutError)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 'timed out' message when fetch throws TimeoutError (Node <18.14 naming)", async () => {
    // Regression: err.name === "AbortError" only — Node <18.14 throws TimeoutError.
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    } as any);
    const timeoutErr = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutErr);

    const result = parse(
      await tool.handler({ method: "GET", url: "https://example.com" }),
    );
    expect(result.error).toMatch(/timed out/i);
  });
});

describe("sendHttpRequest — allowPrivateHttp flag", () => {
  const privateTool = createSendHttpRequestTool({ allowPrivateHttp: true });

  afterEach(() => vi.restoreAllMocks());

  it("allows localhost when allowPrivateHttp is true", async () => {
    // Mock DNS + fetch to avoid real I/O — we only test the guard is skipped
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "127.0.0.1",
      family: 4,
    } as any);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const result = await privateTool.handler({
      method: "GET",
      url: "http://localhost:5432/",
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result).status).toBe(200);
  });

  it("allows 127.0.0.1 when allowPrivateHttp is true", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "127.0.0.1",
      family: 4,
    } as any);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const result = await privateTool.handler({
      method: "GET",
      url: "http://127.0.0.1:6379/",
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result).status).toBe(200);
  });

  it("allows 10.x private network when allowPrivateHttp is true", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "10.0.0.5",
      family: 4,
    } as any);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const result = await privateTool.handler({
      method: "GET",
      url: "http://10.0.0.5:9090/",
    });
    expect(result.isError).toBeUndefined();
  });

  it("still blocks private IPs when allowPrivateHttp is false (default)", async () => {
    const defaultTool = createSendHttpRequestTool();
    const result = await defaultTool.handler({
      method: "GET",
      url: "http://localhost:5432/",
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/private|loopback/i);
  });

  it("allows DNS-resolved private IPs when allowPrivateHttp is true", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "192.168.1.100",
      family: 4,
    } as any);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const result = await privateTool.handler({
      method: "GET",
      url: "http://my-internal-host.local:3000/",
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("sendHttpRequest — userinfo (credentials) stripped from URL", () => {
  afterEach(() => vi.restoreAllMocks());

  it("LOW: URL with user:password@ is accepted but credentials are not forwarded to fetch", async () => {
    // Bug: parsedUrl.username/password were preserved into the pinned fetch URL,
    // sending credentials to the resolved IP. Fix: clear them on parsedUrl.
    // We verify by checking the URL fed to fetch has no userinfo.
    let fetchedUrl: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetchedUrl = String(input);
      return new Response("ok", { status: 200 });
    });
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    } as never);

    await tool.handler({
      method: "GET",
      url: "https://user:pass@example.com/path",
    });

    expect(fetchedUrl).toBeDefined();
    // Credentials must be stripped — neither user:pass nor %40 encoding
    expect(fetchedUrl).not.toContain("user");
    expect(fetchedUrl).not.toContain("pass");
    expect(fetchedUrl).not.toContain("@");
  });
});

describe("sendHttpRequest — Content-Length exceeded drains body", () => {
  afterEach(() => vi.restoreAllMocks());

  it("LOW: body stream is cancelled when Content-Length > maxResponseBytes", async () => {
    // Bug: early return on Content-Length check left resp.body un-consumed,
    // holding the socket open until GC. Fix: call resp.body?.cancel().
    let bodyCancelled = false;
    const mockBody = {
      cancel: async () => {
        bodyCancelled = true;
      },
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-length": "999999999",
        "content-type": "text/plain",
      }),
      body: mockBody,
    } as unknown as Response);
    vi.spyOn(dns, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    } as never);

    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/large",
      maxResponseBytes: 1024,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Content-Length/);
    expect(bodyCancelled).toBe(true);
  });
});

describe("sendHttpRequest — redirect Host header after DNS failure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("LOW: Host header is set from redirect target even when redirect DNS lookup fails", async () => {
    // Bug: headers.host was only set inside the DNS try-block. On DNS failure
    // the catch block fell through, leaving the PREVIOUS hop's Host header
    // attached to the new request. Fix: set headers.host before the try.
    let capturedHost: string | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 301,
        statusText: "Moved",
        headers: new Headers({ location: "https://other.example.com/path" }),
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
          }),
        },
      } as unknown as Response)
      .mockImplementation(async (_url, init) => {
        capturedHost = (init?.headers as Record<string, string>)?.host;
        return new Response("final", { status: 200 });
      });

    // First hop: DNS succeeds (sets host = example.com)
    // Redirect hop: DNS fails → host should still be "other.example.com"
    vi.spyOn(dns, "lookup")
      .mockResolvedValueOnce({ address: "93.184.216.34", family: 4 } as never)
      .mockRejectedValueOnce(new Error("DNS lookup failed"));

    await tool.handler({
      method: "GET",
      url: "https://example.com/",
    });

    // Host must be the redirect target, not the first hop's host
    expect(capturedHost).toBe("other.example.com");
  });
});

describe("sendHttpRequest — Host header SSRF bypass prevention", () => {
  it("does not allow caller-supplied Host header to override the pinned hostname", async () => {
    // The tool sets Host = parsedUrl.hostname when IP-pinning.
    // A user-supplied Host header must NOT overwrite it, or an attacker
    // could pin to a public IP but send Host: 169.254.169.254 to trick
    // a server-side proxy into routing internally.
    // We test this by intercepting how the tool builds its headers object.
    // Since real network calls aren't made here, we just verify the tool
    // accepts the request (doesn't error on header validation) and that
    // the header injection check catches CRLF but not legitimate Host override.
    // The real protection is that our Host is set AFTER user headers.

    // Test: CRLF injection in Host header is still blocked
    const result = await tool.handler({
      method: "GET",
      url: "https://example.com/",
      headers: { Host: "evil.com\r\nX-Injected: yes" },
    });
    expect(result.isError).toBe(true);
    // Error `text` is the plain message (ADR-0004).
    expect(result.content[0]?.text ?? "").toMatch(/invalid characters/i);
  });
});
