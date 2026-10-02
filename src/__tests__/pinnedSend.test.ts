/**
 * `pinnedSend` — the one outbound path for the approval/halt notification
 * senders (webhook, push send, push dismiss, halt push, ntfy x2).
 *
 * Security sweep 2026-10-01, L3. Each sender checked DNS and then called bare
 * `fetch`, which resolved the name AGAIN — a rebinding window between the
 * check and the connection — and followed redirects with no re-validation.
 * They were the last outbound sinks not on the shared guard.
 *
 * The senders' own check was stricter than safeFetch's default, and that is
 * kept: resolve ALL addresses and refuse if ANY is private, and fail CLOSED
 * when DNS fails (safeFetch's default proceeds unpinned). The address that
 * check accepted is then the pin, so nothing resolves a second time.
 */
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinnedSend } from "../pinnedSend.js";

let warnSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const init = () => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});

describe("pinnedSend — DNS check (stricter than safeFetch's default)", () => {
  it("resolves ONCE and hands fetch a pinning dispatcher with the real hostname in the URL", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "203.0.113.10", family: 4 }] as never);
    const res = await pinnedSend("https://relay.example.test/push", init(), {
      label: "push",
    });
    expect(res?.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    const [url, req] = fetchSpy.mock.calls[0] as [
      string,
      { dispatcher?: unknown; redirect?: string },
    ];
    expect(new URL(url).hostname).toBe("relay.example.test");
    expect(req.dispatcher).toBeDefined();
  });

  it("refuses — no fetch — when ANY resolved address is private", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);
    const res = await pinnedSend("https://relay.example.test/push", init(), {
      label: "push",
    });
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[push]"));
  });

  it("fails CLOSED — no fetch — when DNS fails (safeFetch's default would proceed unpinned)", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    const res = await pinnedSend("https://relay.example.test/push", init(), {
      label: "push",
    });
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allowPrivate permits a private address and still pins it", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "10.0.0.5", family: 4 },
    ] as never);
    const res = await pinnedSend("https://relay.example.test/push", init(), {
      label: "push",
      allowPrivate: true,
    });
    expect(res?.status).toBe(200);
    const [, req] = fetchSpy.mock.calls[0] as [
      string,
      { dispatcher?: unknown },
    ];
    expect(req.dispatcher).toBeDefined();
  });

  it("is immune to rebinding: a second, private answer is never consulted", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }] as never)
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    await pinnedSend("https://relay.example.test/push", init(), {
      label: "push",
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("pinnedSend — redirects are not followed", () => {
  it("asks fetch for manual redirects and returns a 3xx as-is", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ] as never);
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      }),
    );
    const res = await pinnedSend("https://relay.example.test/push", init(), {
      label: "push",
    });
    expect(res?.status).toBe(302);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, req] = fetchSpy.mock.calls[0] as [string, { redirect?: string }];
    expect(req.redirect).toBe("manual");
  });
});

describe("pinnedSend — the pin is real at the socket", () => {
  let server: http.Server;
  let port = 0;
  let hostSeen: string | undefined;
  beforeEach(async () => {
    vi.unstubAllGlobals(); // real fetch for this block
    server = http.createServer((req, res) => {
      hostSeen = req.headers.host;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reaches the checked address for a name with no public DNS", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
    ] as never);
    const res = await pinnedSend(
      `http://pin.example.test:${port}/push`,
      { method: "GET" },
      { label: "push", allowPrivate: true },
    );
    expect(res?.status).toBe(200);
    expect(hostSeen).toBe(`pin.example.test:${port}`);
  });
});

describe("no notification sender bypasses pinnedSend", () => {
  it.each([
    "approvalHttp.ts",
    "haltPushDispatch.ts",
  ])("%s contains no bare fetch(", (file) => {
    const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const bare = src
      .split("\n")
      .filter((l) => /(^|[^.\w])fetch\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    expect(
      bare,
      `${file} calls fetch directly — route it through pinnedSend so the DNS ` +
        "answer it checked is the address it connects to.",
    ).toEqual([]);
  });
});
