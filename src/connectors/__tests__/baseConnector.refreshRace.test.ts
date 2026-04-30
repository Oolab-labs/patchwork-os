/**
 * Regression tests for the token-refresh inflight guard.
 *
 * Without the guard, two concurrent expired-token callers both POST to the
 * IdP token endpoint. On Google (and any IdP that rotates refresh tokens on
 * use), the second POST burns the rotated refresh_token issued by the first,
 * which invalidates the connector entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "../baseConnector.js";

const storeTokens = vi.fn().mockResolvedValue(undefined);
const getTokens = vi.fn().mockResolvedValue(null);
const deleteTokens = vi.fn().mockResolvedValue(undefined);

vi.mock("../tokenStorage.js", () => ({
  storeTokens: (...args: unknown[]) => storeTokens(...args),
  getTokens: (...args: unknown[]) => getTokens(...args),
  deleteTokens: (...args: unknown[]) => deleteTokens(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

class TestConnector extends BaseConnector {
  readonly providerName = "test-provider";

  protected getOAuthConfig(): OAuthConfig | null {
    return {
      clientId: "test-client",
      clientSecret: "test-secret",
      tokenEndpoint: "https://oauth.example.com/token",
    };
  }

  async authenticate(): Promise<AuthContext> {
    throw new Error("authenticate not configured");
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

  setAuth(auth: AuthContext | null) {
    this.auth = auth;
  }

  callRefreshDeduped() {
    return this.refreshTokenDeduped();
  }
}

beforeEach(() => {
  mockFetch.mockReset();
  storeTokens.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("BaseConnector.refreshTokenDeduped()", () => {
  it("dedupes concurrent refreshes — single fetch for N parallel callers", async () => {
    const c = new TestConnector();
    c.setAuth({
      token: "at_old",
      refreshToken: "rt_v1",
      expiresAt: new Date(Date.now() - 1000),
    });

    let resolveFetch!: (v: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const calls = Array.from({ length: 5 }, () => c.callRefreshDeduped());

    // All 5 callers await the same in-flight promise. Resolve the single fetch
    // and all 5 must complete with the same new token.
    resolveFetch(
      new Response(
        JSON.stringify({
          access_token: "at_new",
          refresh_token: "rt_v2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const results = await Promise.all(calls);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.token === "at_new")).toBe(true);
  });

  it("clears inflight cache after success — next caller fetches fresh", async () => {
    const c = new TestConnector();
    c.setAuth({
      token: "at_old",
      refreshToken: "rt_v1",
      expiresAt: new Date(Date.now() - 1000),
    });

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at_new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await c.callRefreshDeduped();
    await c.callRefreshDeduped();

    // Two sequential calls = two fetches (cache cleared in finally).
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("clears inflight cache after failure — next caller retries", async () => {
    const c = new TestConnector();
    c.setAuth({
      token: "at_old",
      refreshToken: "rt_v1",
      expiresAt: new Date(Date.now() - 1000),
    });

    // First refresh: server returns 500 → returns null (transient).
    mockFetch.mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    // Second refresh: success.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "at_new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const first = await c.callRefreshDeduped();
    expect(first).toBeNull();

    const second = await c.callRefreshDeduped();
    expect(second?.token).toBe("at_new");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
