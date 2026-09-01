/**
 * Outbound HTTP safety — the ONE guard behind `sendHttpRequest` and the
 * recipe `http.post` tool (Phase 0 step 9).
 *
 * Exercises `validateOutboundUrl` + `safeFetch` directly with an injected
 * resolver and an injected fetch, so no DNS or network is touched. The
 * consumer-level regression (a private-resolving public hostname refused by
 * the recipe tool) lives in src/recipes/tools/__tests__/http.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import {
  OutboundHttpError,
  safeFetch,
  validateOutboundUrl,
} from "../ssrfGuard.js";

const publicDns = async () => "93.184.216.34";
const failingDns = async () => {
  throw new Error("ENOTFOUND");
};

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}
const ok = () => new Response("ok", { status: 200 });

describe("validateOutboundUrl — lexical refusals (no DNS reached)", () => {
  const cases: Array<[string, string]> = [
    ["localhost", "http://localhost/"],
    ["sub.localhost", "http://api.localhost/"],
    ["127.0.0.1", "http://127.0.0.1/"],
    ["10/8", "http://10.0.0.1/"],
    ["172.16/12", "http://172.16.5.5/"],
    ["192.168/16", "http://192.168.1.1/"],
    ["169.254/16 (IMDS)", "http://169.254.169.254/"],
    ["100.64/10 (CGNAT)", "http://100.64.0.1/"],
    ["0/8", "http://0.0.0.0/"],
    ["::1", "http://[::1]/"],
    ["fc00::/7", "http://[fc00::1]/"],
    ["fe80::/10", "http://[fe80::1]/"],
    ["::ffff:127.0.0.1", "http://[::ffff:127.0.0.1]/"],
    ["hex 0x7f000001", "http://0x7f000001/"],
    ["decimal 2130706433", "http://2130706433/"],
    ["octal 0177.0.0.1", "http://0177.0.0.1/"],
    ["short 127.1", "http://127.1/"],
  ];
  for (const [label, url] of cases) {
    it(`refuses ${label}`, async () => {
      const resolve = vi.fn(publicDns);
      const v = await validateOutboundUrl(url, { resolveDns: resolve });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("private_host");
      expect(resolve).not.toHaveBeenCalled();
    });
  }

  it("refuses non-http(s) and malformed URLs", async () => {
    expect((await validateOutboundUrl("file:///etc/passwd")).reason).toBe(
      "unsupported_protocol",
    );
    expect((await validateOutboundUrl("not a url")).reason).toBe("invalid_url");
  });

  it("strips userinfo and never returns it", async () => {
    const v = await validateOutboundUrl("https://user:pass@example.test/p", {
      resolveDns: publicDns,
    });
    expect(v.ok).toBe(true);
    expect(v.url?.toString()).not.toContain("user");
    expect(v.url?.username).toBe("");
  });
});

describe("validateOutboundUrl — DNS re-check and pinning", () => {
  it("refuses a public hostname whose resolver answers 10.0.0.1", async () => {
    const v = await validateOutboundUrl("https://internal.example.test/", {
      resolveDns: async () => "10.0.0.1",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("private_host_after_dns");
  });

  it("refuses a resolver answer in unusual notation (::ffff:7f00:1)", async () => {
    const v = await validateOutboundUrl("https://mapped.example.test/", {
      resolveDns: async () => "::ffff:7f00:1",
    });
    expect(v.reason).toBe("private_host_after_dns");
  });

  it("returns the resolved public address for pinning", async () => {
    const v = await validateOutboundUrl("https://example.test/", {
      resolveDns: publicDns,
    });
    expect(v).toMatchObject({ ok: true, pinnedAddress: "93.184.216.34" });
  });

  it("proceeds unpinned when the resolver fails (transport reports the error)", async () => {
    const v = await validateOutboundUrl("https://example.test/", {
      resolveDns: failingDns,
    });
    expect(v.ok).toBe(true);
    expect(v.pinnedAddress).toBeUndefined();
  });

  it("allowPrivate skips the range check but still pins", async () => {
    const v = await validateOutboundUrl("http://127.0.0.1:9000/", {
      allowPrivate: true,
      resolveDns: async () => "127.0.0.1",
    });
    expect(v).toMatchObject({ ok: true, pinnedAddress: "127.0.0.1" });
  });
});

describe("safeFetch — pinning and redirects", () => {
  it("pins the first hop to the resolved IP and carries the real name in Host", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await safeFetch(
      "https://api.example.test/v1",
      { headers: { Host: "attacker.example.test" } },
      { fetchImpl, resolveDns: publicDns },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; redirect: string },
    ];
    expect(url).toBe("https://93.184.216.34/v1");
    expect(init.headers.host).toBe("api.example.test");
    expect(init.redirect).toBe("manual");
  });

  it("brackets an IPv6 pin", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await safeFetch(
      "https://v6.example.test/",
      {},
      { fetchImpl, resolveDns: async () => "2001:db8::1" },
    );
    expect((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      "https://[2001:db8::1]/",
    );
  });

  it("refuses a redirect chain from a public host to a private address", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(redirect("http://169.254.169.254/latest/"))
      .mockResolvedValueOnce(ok());
    await expect(
      safeFetch(
        "https://public.example.test/",
        {},
        { fetchImpl, resolveDns: publicDns },
      ),
    ).rejects.toMatchObject({
      name: "OutboundHttpError",
      code: "private_host",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a hostname that resolves privately", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(redirect("https://inner.example.test/"))
      .mockResolvedValueOnce(ok());
    const resolveDns = vi
      .fn<(h: string) => Promise<string>>()
      .mockResolvedValueOnce("93.184.216.34")
      .mockResolvedValueOnce("192.168.0.10");
    await expect(
      safeFetch("https://public.example.test/", {}, { fetchImpl, resolveDns }),
    ).rejects.toMatchObject({ code: "private_host_after_dns" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops Authorization/Cookie on a cross-origin redirect", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(redirect("https://other.example.test/x"))
      .mockResolvedValueOnce(ok());
    await safeFetch(
      "https://api.example.test/",
      {
        headers: { Authorization: "Bearer S", Cookie: "s=1", "X-Api-Key": "k" },
      },
      { fetchImpl, resolveDns: publicDns },
    );
    const second = (
      fetchImpl.mock.calls[1] as unknown as [
        string,
        { headers: Record<string, string> },
      ]
    )[1];
    expect(second.headers.authorization).toBeUndefined();
    expect(second.headers.cookie).toBeUndefined();
    expect(second.headers["x-api-key"]).toBeUndefined();
    expect(second.headers.host).toBe("other.example.test");
  });

  it("keeps Authorization on a same-origin redirect", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(redirect("/v2"))
      .mockResolvedValueOnce(ok());
    const result = await safeFetch(
      "https://api.example.test/v1",
      { headers: { Authorization: "Bearer S" } },
      { fetchImpl, resolveDns: publicDns },
    );
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.authorization).toBe("Bearer S");
    // Relative Location resolved against the REAL name, then pinned.
    expect(url).toBe("https://93.184.216.34/v2");
    expect(result.finalUrl).toBe("https://api.example.test/v2");
    expect(result.redirects).toBe(1);
  });

  it("downgrades POST+body to GET on 302 and preserves it on 307", async () => {
    for (const [status, method, hasBody] of [
      [302, "GET", false],
      [307, "POST", true],
    ] as const) {
      const fetchImpl = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(redirect("/next", status))
        .mockResolvedValueOnce(ok());
      await safeFetch(
        "https://api.example.test/",
        {
          method: "POST",
          body: "payload",
          headers: { "content-type": "text/plain" },
        },
        { fetchImpl, resolveDns: publicDns },
      );
      const init = (
        fetchImpl.mock.calls[1] as unknown as [
          string,
          { method: string; body?: string; headers: Record<string, string> },
        ]
      )[1];
      expect(init.method).toBe(method);
      expect(init.body !== undefined).toBe(hasBody);
      expect("content-type" in init.headers).toBe(hasBody);
    }
  });

  it("caps redirect hops", async () => {
    const fetchImpl = vi.fn(async () => redirect("/loop"));
    await expect(
      safeFetch(
        "https://api.example.test/",
        {},
        { fetchImpl, resolveDns: publicDns, maxRedirects: 3 },
      ),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not follow when followRedirects is false", async () => {
    const fetchImpl = vi.fn(async () => redirect("/next"));
    const { response, redirects } = await safeFetch(
      "https://api.example.test/",
      {},
      { fetchImpl, resolveDns: publicDns, followRedirects: false },
    );
    expect(response.status).toBe(302);
    expect(redirects).toBe(0);
  });

  it("refuses a redirect to a non-http(s) scheme", async () => {
    const fetchImpl = vi.fn(async () => redirect("file:///etc/passwd"));
    await expect(
      safeFetch(
        "https://api.example.test/",
        {},
        { fetchImpl, resolveDns: publicDns },
      ),
    ).rejects.toBeInstanceOf(OutboundHttpError);
  });

  it("allowPrivate permits loopback end to end", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const { response } = await safeFetch(
      "http://127.0.0.1:9000/x",
      {},
      { fetchImpl, resolveDns: async () => "127.0.0.1", allowPrivate: true },
    );
    expect(response.status).toBe(200);
    expect((fetchImpl.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      "http://127.0.0.1:9000/x",
    );
  });
});
