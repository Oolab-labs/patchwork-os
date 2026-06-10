/**
 * Audit 2026-06-10 cluster C7 regression tests for src/connectorRoutes.ts.
 *
 * http-routes-5 — GET /connections caches handleConnectionsList() for a short
 *   TTL so the dashboard polling loop doesn't re-probe 45+ connector keychains
 *   on every request. Any mutating /connections/* request invalidates it.
 * http-routes-3 — OAuth callback paths must be registered ONLY in
 *   tryHandlePublicConnectorRoute (pre-auth). The bearer-gated
 *   tryHandleConnectorRoute must no longer claim them as dead duplicates.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSpy = vi.fn(async () => ({
  status: 200,
  body: JSON.stringify({ connectors: [] }),
  contentType: "application/json",
}));

vi.mock("../connectors/gmail.js", () => ({
  handleConnectionsList: listSpy,
}));

import {
  tryHandleConnectorRoute,
  tryHandlePublicConnectorRoute,
} from "../connectorRoutes.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes(): { res: ServerResponse; done: Promise<void> } {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const res = {
    writeHead() {
      return this;
    },
    end() {
      resolveDone();
      return this;
    },
  } as unknown as ServerResponse;
  return { res, done };
}

async function getConnections(): Promise<void> {
  const { res, done } = makeRes();
  tryHandleConnectorRoute(makeReq("GET"), res, new URL("http://x/connections"));
  await done;
}

// The connections cache is module-level state — drop it before each test via
// a mutating non-GET /connections/* request so tests don't leak cache hits.
function invalidateConnectionsCache(): void {
  const res = {
    writeHead() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  tryHandleConnectorRoute(
    makeReq("DELETE"),
    res,
    new URL("http://x/connections/__reset__"),
  );
}

beforeEach(() => {
  invalidateConnectionsCache();
  listSpy.mockClear();
});

afterEach(() => {
  listSpy.mockClear();
  vi.useRealTimers();
});

describe("http-routes-5 — GET /connections TTL cache", () => {
  it("only probes handleConnectionsList once for back-to-back GETs", async () => {
    await getConnections();
    await getConnections();
    await getConnections();
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("re-probes after a mutating /connections/* request invalidates the cache", async () => {
    await getConnections();
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Any non-GET /connections/* request invalidates the cache at function
    // entry. Use an unmatched synthetic path so no async vendor handler runs
    // (the invalidation guard fires regardless of whether a route matches).
    const { res } = makeRes();
    const handled = tryHandleConnectorRoute(
      makeReq("DELETE"),
      res,
      new URL("http://x/connections/__cache_invalidation_probe__"),
    );
    expect(handled).toBe(false);

    await getConnections();
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it("re-probes once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    await getConnections();
    expect(listSpy).toHaveBeenCalledTimes(1);
    // Stay inside the TTL — still cached.
    vi.advanceTimersByTime(4_000);
    await getConnections();
    expect(listSpy).toHaveBeenCalledTimes(1);
    // Cross the 5 s TTL — re-probe.
    vi.advanceTimersByTime(2_000);
    await getConnections();
    expect(listSpy).toHaveBeenCalledTimes(2);
  });
});

describe("http-routes-3 — OAuth callbacks not duplicated in the auth-gated dispatcher", () => {
  for (const vendor of ["sentry", "discord", "gitlab"]) {
    it(`tryHandleConnectorRoute does NOT claim /connections/${vendor}/callback`, () => {
      const { res } = makeRes();
      const handled = tryHandleConnectorRoute(
        makeReq("GET"),
        res,
        new URL(`http://x/connections/${vendor}/callback`),
      );
      expect(handled).toBe(false);
    });

    it(`tryHandlePublicConnectorRoute DOES claim /connections/${vendor}/callback`, () => {
      const { res } = makeRes();
      const handled = tryHandlePublicConnectorRoute(
        makeReq("GET"),
        res,
        new URL(`http://x/connections/${vendor}/callback?code=abc&state=xyz`),
      );
      expect(handled).toBe(true);
    });
  }
});
