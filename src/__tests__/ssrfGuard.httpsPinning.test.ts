/**
 * safeFetch pins the CONNECTION, not the URL.
 *
 * #1572 (2026-09-02) pinned DNS by rewriting the request URL's hostname to
 * the resolved IP and carrying the real name in a `Host` header. That works
 * for plain HTTP and breaks every HTTPS request: TLS takes its server name
 * (SNI) and certificate check from the URL, not from `Host`, so a public
 * site's certificate was verified against an IP and rejected with
 * ERR_TLS_CERT_ALTNAME_INVALID. Recipe `http.post` and the `sendHttpRequest`
 * tool both go through safeFetch, so both failed for any public HTTPS target
 * whose DNS resolved — found 2026-10-02 by probing the installed build against
 * a public endpoint. Plain HTTP and loopback kept working, which is why the
 * suite and `doctor acceptance` (loopback http) stayed green.
 *
 * The contract now:
 *   1. the URL handed to fetch keeps the REAL hostname (so SNI and the
 *      certificate check use the name), and
 *   2. the pin is enforced at connect time — the connection goes to the
 *      already-validated address however the name would resolve.
 *
 * (2) is proven with a name that does not resolve in public DNS: if the pin
 * were not applied at connect time, the request could not reach the loopback
 * server at all.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "../ssrfGuard.js";

let server: http.Server;
let port = 0;
let seen: Array<{ host: string | undefined; url: string | undefined }>;

beforeEach(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("safeFetch — the URL keeps the real hostname (TLS uses the name)", () => {
  it("does NOT rewrite an https URL's hostname to the pinned IP", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await safeFetch(
      "https://api.example.test/v1/thing",
      {},
      { fetchImpl, resolveDns: async () => "93.184.216.34" },
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(url).hostname).toBe("api.example.test");
  });

  it("does not inject a Host header (fetch derives it from the URL)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await safeFetch(
      "https://api.example.test/",
      {},
      { fetchImpl, resolveDns: async () => "93.184.216.34" },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.host).toBeUndefined();
  });

  it("passes a dispatcher that carries the pin", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await safeFetch(
      "https://api.example.test/",
      {},
      { fetchImpl, resolveDns: async () => "93.184.216.34" },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { dispatcher?: unknown },
    ];
    expect(init.dispatcher).toBeDefined();
  });
});

describe("safeFetch — the pin is enforced at connect time (real socket)", () => {
  it("reaches the pinned address for a name that does not resolve publicly", async () => {
    const r = await safeFetch(
      `http://pin.example.test:${port}/probe`,
      { method: "GET" },
      { allowPrivate: true, resolveDns: async () => "127.0.0.1" },
    );
    expect(r.response.status).toBe(200);
    expect(await r.response.text()).toBe("ok");
    expect(seen).toHaveLength(1);
    // The server sees the REAL name, derived from the URL — not an IP.
    expect(seen[0]?.host).toBe(`pin.example.test:${port}`);
    expect(seen[0]?.url).toBe("/probe");
  });

  it("lets the caller wrap the pinned dispatcher (http.post's sent-boundary tracking)", async () => {
    let wrapped = 0;
    const r = await safeFetch(
      `http://pin.example.test:${port}/`,
      { method: "GET" },
      {
        allowPrivate: true,
        resolveDns: async () => "127.0.0.1",
        wrapDispatcher: (d) => {
          wrapped++;
          return d;
        },
      },
    );
    expect(r.response.status).toBe(200);
    expect(wrapped).toBe(1);
  });
});
