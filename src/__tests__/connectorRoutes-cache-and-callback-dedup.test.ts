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
import { oauthConnectorIds } from "../connectors/connectorRegistry.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

// Records which responses actually got written, so a test can assert the
// route finished rather than merely that it claimed the path (#1386).
const endedResponses = new WeakSet<ServerResponse>();

function endedFor(res: ServerResponse): boolean {
  return endedResponses.has(res);
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
      endedResponses.add(res);
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
  // DERIVED from the registry, not hand-listed.
  //
  // This loop read `["sentry", "discord", "gitlab"]` — precisely the three
  // duplicates someone had ALREADY removed. It locked in what was fixed
  // instead of enumerating what the invariant covers, so it sat green while
  // four other callbacks (linear, asana, google-calendar, google-drive) stayed
  // duplicated in the auth-gated dispatcher. A guard that lists its own past
  // successes cannot fail on the next instance.
  //
  // `oauthConnectorIds()` existed for exactly this and had zero call sites
  // anywhere in the repo. Deriving the list means a connector added tomorrow
  // is covered without anyone remembering to extend this array.
  const vendors = oauthConnectorIds();

  it("derives a non-empty vendor list (anchor)", () => {
    // Without this, an empty registry would make every assertion below vacuous
    // and the whole describe block would pass by iterating nothing.
    expect(vendors.length).toBeGreaterThanOrEqual(13);
  });

  for (const vendor of vendors) {
    it(`tryHandleConnectorRoute does NOT claim /connections/${vendor}/callback`, () => {
      const { res } = makeRes();
      const handled = tryHandleConnectorRoute(
        makeReq("GET"),
        res,
        new URL(`http://x/connections/${vendor}/callback`),
      );
      expect(handled).toBe(false);
    });

    it(`tryHandlePublicConnectorRoute DOES claim /connections/${vendor}/callback`, async () => {
      const { res, done } = makeRes();
      const handled = tryHandlePublicConnectorRoute(
        makeReq("GET"),
        res,
        new URL(`http://x/connections/${vendor}/callback?code=abc&state=xyz`),
      );
      expect(handled).toBe(true);
      // `await done` is load-bearing, not tidiness (#1386). The route body is
      // a fire-and-forget `void (async () => { await import(...) })()` — it
      // returns `true` while the connector module graph is STILL LOADING
      // (measured: 2.7-14.6 ms after return, for all 13 vendors). Asserting
      // `handled` and returning here left up to 13 in-flight dynamic imports
      // per file; whichever had not resolved when vitest tore the environment
      // down threw `EnvironmentTeardownError: Cannot load .../mcpOAuth.ts
      // imported from src/connectors/github.ts after the environment was torn
      // down`, failing the CI step AFTER every test had reported passing.
      // Timing-dependent, hence the flakiness and the Windows bias.
      //
      // The `ended` assertion is what keeps this honest: delete the await and
      // it fails deterministically rather than going quietly back to leaking.
      await done;
      expect(endedFor(res)).toBe(true);
    });
  }
});
