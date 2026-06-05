/**
 * http.post tool — SSRF guard + happy-path tests.
 *
 * The execute path calls undiciFetch (not globalThis.fetch); tests mock undici.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../../toolRegistry.js";
import type { RunContext } from "../../yamlRunner.js";
import { isPrivateHost } from "../http.js";

// Trigger self-registration of http.post into the global registry.
import "../http.js";

// Mock undici so tests never make real network calls.
vi.mock("undici", () => {
  const mockFetch = vi.fn();
  return {
    // biome-ignore lint/complexity/useArrowFunction: must be constructable with `new` — vitest 4 runs the mock impl as a constructor
    Agent: vi.fn().mockImplementation(function () {
      return {};
    }),
    fetch: mockFetch,
  };
});

import { fetch as mockUndiciFetch } from "undici";

function makeCtx(params: Record<string, unknown>) {
  return {
    params,
    step: { ...params, tool: "http.post" },
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {
      workdir: "/tmp",
    } as any,
  };
}

function makeMockResponse(body: string, status = 202) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
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
  it("rejects CGNAT (RFC 6598 100.64.0.0/10) — canonical-guard coverage", () => {
    // The local lexical copy in http.ts missed 100.64.0.0/10; the canonical
    // ssrfGuard covers it. Concrete address verified by reading both impls.
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.254")).toBe(true);
    // outside the /10 stays public
    expect(isPrivateHost("100.63.0.1")).toBe(false);
    expect(isPrivateHost("100.128.0.1")).toBe(false);
  });
});

describe("http.post — execute", () => {
  beforeEach(() => {
    vi.mocked(mockUndiciFetch).mockResolvedValue(
      makeMockResponse("echo:POST:hello") as any,
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(mockUndiciFetch).mockResolvedValue(makeMockResponse("ok") as any);
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

  it("blocks allowPrivate bypass when PATCHWORK_FLAG_BLOCK_RECIPE_ALLOW_PRIVATE is on", async () => {
    vi.stubEnv("PATCHWORK_FLAG_BLOCK_RECIPE_ALLOW_PRIVATE", "true");
    try {
      await expect(
        executeTool(
          "http.post",
          makeCtx({
            url: "http://127.0.0.1:9000/x",
            body: "x",
            allowPrivate: true,
          }),
        ),
      ).rejects.toThrow(/private\/loopback/);
      // fetch must never be reached when the bypass is disabled
      expect(mockUndiciFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
