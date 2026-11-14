/**
 * The outbound guard's refusal paths, each with the fetch replaced so the
 * test can count what would have been sent.
 *
 * A mutation run (Stryker, 2026-11-14) listed these rules as removable with
 * the existing suite still green. Every test uses a stub resolver returning a
 * public address and a stub fetch, so nothing leaves the machine.
 */

import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  OutboundHttpError,
  safeFetch,
  validateOutboundUrl,
} from "../ssrfGuard.js";

const PUBLIC = "93.184.216.34";
const resolveDns = async () => PUBLIC;

/** A fetch that answers from a script and records every call. */
function scripted(answers: Array<(url: string) => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: { ...(init.headers as Record<string, string>) },
    });
    // A guard that stops counting redirects would otherwise loop forever on
    // resolved promises, which no test timeout can interrupt.
    if (calls.length > 20) throw new Error("fetch called more than 20 times");
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (!next) throw new Error("no scripted answer");
    return next(url);
  };
  return { calls, fetchImpl };
}
const redirectTo =
  (location: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location } });
const ok = () => new Response("ok", { status: 200 });

describe("validateOutboundUrl refuses what it cannot vouch for", () => {
  it("an unparseable URL", async () => {
    const r = await validateOutboundUrl("not a url", { resolveDns });
    expect(r).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("every protocol other than http and https", async () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://a.example.test/x",
      "gopher://a.example.test/",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "ws://a.example.test/",
    ]) {
      const r = await validateOutboundUrl(u, { resolveDns });
      expect(r, u).toMatchObject({ ok: false, reason: "unsupported_protocol" });
    }
    expect(
      (await validateOutboundUrl("https://a.example.test/", { resolveDns })).ok,
    ).toBe(true);
  });
});

describe("safeFetch never sends what the guard refused", () => {
  it("a private first hop is refused before any request", async () => {
    const { calls, fetchImpl } = scripted([ok]);
    await expect(
      safeFetch("http://127.0.0.1/", {}, { fetchImpl, resolveDns }),
    ).rejects.toBeInstanceOf(OutboundHttpError);
    await expect(
      safeFetch("file:///etc/passwd", {}, { fetchImpl, resolveDns }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("a redirect to a private address is refused, and the private hop is never requested", async () => {
    for (const target of [
      "http://10.0.0.1/",
      "http://169.254.169.254/latest",
      "file:///etc/passwd",
    ]) {
      const { calls, fetchImpl } = scripted([redirectTo(target), ok]);
      await expect(
        safeFetch("https://a.example.test/", {}, { fetchImpl, resolveDns }),
        target,
      ).rejects.toBeInstanceOf(OutboundHttpError);
      expect(
        calls.map((c) => c.url),
        target,
      ).toEqual(["https://a.example.test/"]);
    }
  });

  it("credentials are dropped on a cross-origin redirect and kept on a same-origin one", async () => {
    const creds = {
      Authorization: "Bearer example-token",
      Cookie: "sid=example",
      "X-Api-Key": "example-key",
      apikey: "example-service-key",
      "Proxy-Authorization": "Basic example",
    };
    const cross = scripted([redirectTo("https://b.example.test/next"), ok]);
    await safeFetch(
      "https://a.example.test/",
      { headers: creds },
      {
        fetchImpl: cross.fetchImpl,
        resolveDns,
      },
    );
    expect(cross.calls).toHaveLength(2);
    for (const h of [
      "authorization",
      "cookie",
      "x-api-key",
      "apikey",
      "proxy-authorization",
    ]) {
      expect(cross.calls[0]?.headers[h], `first hop ${h}`).toBeDefined();
      expect(
        cross.calls[1]?.headers[h],
        `cross-origin hop ${h}`,
      ).toBeUndefined();
    }
    const same = scripted([redirectTo("/next"), ok]);
    await safeFetch(
      "https://a.example.test/",
      { headers: creds },
      {
        fetchImpl: same.fetchImpl,
        resolveDns,
      },
    );
    expect(same.calls[1]?.headers.authorization).toBe("Bearer example-token");
  });

  it("stops after maxRedirects instead of following a loop", async () => {
    const { calls, fetchImpl } = scripted([
      redirectTo("https://a.example.test/again"),
    ]);
    await expect(
      safeFetch(
        "https://a.example.test/",
        {},
        { fetchImpl, resolveDns, maxRedirects: 3 },
      ),
    ).rejects.toThrow(/Too many redirects/);
    expect(calls).toHaveLength(4);
  });
});
