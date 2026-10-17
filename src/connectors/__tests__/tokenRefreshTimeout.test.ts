/**
 * A token refresh must not wait forever on an identity provider that never
 * answers (audit M24, 2026-10-15).
 *
 * The refresh fetch had no timeout, and `refreshTokenDeduped` shares one
 * in-flight promise between every caller. One hung token endpoint therefore
 * wedged EVERY later call on that connector, not just the first.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "../baseConnector.js";
import { _setTokenRefreshTimeoutForTests } from "../tokenRefreshTimeout.js";

vi.mock("../tokenStorage.js", () => ({
  storeTokens: vi.fn().mockResolvedValue(undefined),
  getTokens: vi.fn().mockResolvedValue(null),
  deleteTokens: vi.fn().mockResolvedValue(undefined),
}));

class TestConnector extends BaseConnector {
  readonly providerName = "test-provider";
  protected getOAuthConfig(): OAuthConfig | null {
    return {
      clientId: "test-client",
      clientSecret: "test-secret",
      tokenEndpoint: "https://oauth.example.test/token",
    };
  }
  async authenticate(): Promise<AuthContext> {
    throw new Error("not configured");
  }
  async healthCheck() {
    return { ok: true };
  }
  normalizeError(err: unknown): ConnectorError {
    return {
      code: "provider_error",
      message: err instanceof Error ? err.message : "unknown",
      retryable: false,
    };
  }
  getStatus(): ConnectorStatus {
    return { id: this.providerName, status: "connected" };
  }
  setAuth(auth: AuthContext) {
    this.auth = auth;
  }
  refresh() {
    return this.refreshTokenDeduped();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  _setTokenRefreshTimeoutForTests(undefined);
});

/** A token endpoint that never answers, but honours an abort signal. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      }),
  );
}

/** Resolves to "hung" if `p` has not settled within `ms`. */
function settledWithin<T>(p: Promise<T>, ms: number) {
  return Promise.race([
    p.then((v) => ({ settled: true as const, value: v })),
    new Promise<{ settled: false }>((r) =>
      setTimeout(() => r({ settled: false }), ms),
    ),
  ]);
}

describe("BaseConnector token refresh is bounded", () => {
  it("a hung token endpoint ends the refresh as a failure instead of hanging", async () => {
    _setTokenRefreshTimeoutForTests(200);
    vi.stubGlobal("fetch", hangingFetch());
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt", expiresAt: new Date(0) });

    const outcome = await settledWithin(c.refresh(), 2000);
    expect(outcome.settled).toBe(true);
    expect(outcome.settled && outcome.value).toBeNull();
  });

  it("after the timeout a later caller starts a fresh refresh rather than joining the dead one", async () => {
    _setTokenRefreshTimeoutForTests(200);
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt", expiresAt: new Date(0) });

    await settledWithin(c.refresh(), 2000);
    const second = await settledWithin(c.refresh(), 2000);
    expect(second.settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("every refresh-token request in src/connectors carries a timeout", () => {
  // Structural guard: each connector with its own refresh code calls fetch
  // directly, so a new one would silently reintroduce the hang. A fetch whose
  // options mention `grant_type` … `refresh_token` must pass the shared
  // timeout signal.
  const dir = join(__dirname, "..");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("finds the refresh calls it is checking (a guard over nothing fails)", () => {
    let found = 0;
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      found += refreshFetchBlocks(src).length;
    }
    expect(found).toBeGreaterThanOrEqual(9);
  });

  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const blocks = refreshFetchBlocks(src);
    if (blocks.length === 0) continue;
    it(`${f}: ${blocks.length} refresh fetch(es) pass tokenRefreshSignal()`, () => {
      for (const b of blocks) expect(b).toMatch(/tokenRefreshSignal\(\)/);
    });
  }
});

/**
 * The text of each `fetch(` call that sends a refresh_token grant: the grant
 * is inside the call, or in the 15 lines before it (a body built in a
 * variable first). Matches `grant_type: "refresh_token"` exactly, so a client
 * registration's `grant_types: [..., "refresh_token"]` list is not mistaken
 * for a refresh.
 */
function refreshFetchBlocks(src: string): string[] {
  const grant = /grant_type:\s*"refresh_token"/;
  const out: string[] = [];
  const re = /\bfetch\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const call = src.slice(m.index, end + 1);
    const before = src.slice(0, m.index).split("\n").slice(-15).join("\n");
    if (grant.test(call) || grant.test(before)) out.push(call);
  }
  return out;
}
