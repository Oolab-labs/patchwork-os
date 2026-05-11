/**
 * http.post tool — SSRF guard + happy-path tests.
 *
 * The execute path uses the global `fetch`; tests stub it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../../toolRegistry.js";
import { isPrivateHost } from "../http.js";

// Trigger self-registration of http.post into the global registry.
import "../http.js";

const originalFetch = globalThis.fetch;

function makeCtx(params: Record<string, unknown>) {
  return {
    params,
    step: { ...params, tool: "http.post" },
    ctx: {} as Record<string, unknown>,
    deps: {
      workdir: "/tmp",
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for executeTool
    } as any,
  };
}

describe("http.post — SSRF guard (lexical)", () => {
  it("rejects loopback v4", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.5.6.7")).toBe(true);
  });
  it("rejects loopback v6 and bracketed forms", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
  });
  it("rejects RFC1918 / link-local / ULA", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.5")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.254")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });
  it("rejects localhost and localhost subdomains", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("api.localhost")).toBe(true);
  });
  it("allows public hosts", () => {
    expect(isPrivateHost("ntfy.sh")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });
});

describe("http.post — execute", () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: fetch stub
    (globalThis as any).fetch = async (
      _url: string,
      init: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
      },
    ) => {
      return new Response(`echo:${init.method ?? "GET"}:${init.body ?? ""}`, {
        status: 202,
      });
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs body and returns {status, ok, body}", async () => {
    const out = await executeTool(
      "http.post",
      makeCtx({ url: "https://ntfy.sh/topic", body: "hello" }),
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe(202);
    expect(parsed.ok).toBe(true);
    expect(parsed.body).toBe("echo:POST:hello");
  });

  it("refuses loopback by default", async () => {
    await expect(
      executeTool(
        "http.post",
        makeCtx({ url: "http://127.0.0.1:9000/x", body: "x" }),
      ),
    ).rejects.toThrow(/private\/loopback/);
  });

  it("permits loopback with allowPrivate: true", async () => {
    const out = await executeTool(
      "http.post",
      makeCtx({
        url: "http://127.0.0.1:9000/x",
        body: "x",
        allowPrivate: true,
      }),
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
  });

  it("rejects unsupported protocols", async () => {
    await expect(
      executeTool(
        "http.post",
        makeCtx({ url: "file:///etc/passwd", body: "" }),
      ),
    ).rejects.toThrow(/only http\/https/);
  });

  it("rejects malformed URLs", async () => {
    await expect(
      executeTool("http.post", makeCtx({ url: "not a url", body: "" })),
    ).rejects.toThrow(/invalid URL/);
  });
});
