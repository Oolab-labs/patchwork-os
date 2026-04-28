/**
 * Security tests for OAuth refresh edge cases (HIGH-3 + MED-1 from the
 * 2026-04-28 audit).
 *
 * HIGH-3: `config.tokenEndpoint` was fetched without TLS validation. A
 *         connector subclass populating this from user-modifiable config
 *         could trick the bridge into POSTing the refresh_token to an
 *         attacker host. Refresh now refuses non-HTTPS endpoints.
 *
 * MED-1:  Successful refresh response was trusted blindly. `{}` or
 *         `{access_token: null}` would result in `Bearer undefined`
 *         persisted to the OS keychain. Refresh now validates that
 *         `access_token` is a non-empty string and `expires_in` (when
 *         present) is a sane positive number.
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
  readonly providerName = "test-security";
  oauthConfigOverride: OAuthConfig | null = {
    clientId: "id",
    clientSecret: "secret",
    tokenEndpoint: "https://oauth.example.com/token",
  };

  protected getOAuthConfig(): OAuthConfig | null {
    return this.oauthConfigOverride;
  }

  async authenticate(): Promise<AuthContext> {
    throw new Error("authenticate not configured");
  }

  async healthCheck() {
    return { ok: true };
  }

  normalizeError(): ConnectorError {
    return { code: "provider_error", message: "x", retryable: false };
  }

  getStatus(): ConnectorStatus {
    return { id: this.providerName, status: "connected" };
  }

  setAuth(auth: AuthContext | null) {
    this.auth = auth;
  }
  callRefresh() {
    return this.refreshToken();
  }
}

beforeEach(() => {
  storeTokens.mockClear();
  getTokens.mockClear();
  deleteTokens.mockClear();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("HIGH-3: refreshToken refuses non-HTTPS tokenEndpoint", () => {
  it("rejects http:// endpoint without sending the refresh token", async () => {
    const c = new TestConnector();
    c.oauthConfigOverride = {
      clientId: "id",
      tokenEndpoint: "http://oauth.example.com/token", // ← plain HTTP
    };
    c.setAuth({ token: "at", refreshToken: "rt-secret" });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    // CRITICAL: must not have made the request
    expect(mockFetch).not.toHaveBeenCalled();
    // and must not have wiped the user's tokens for a misconfig
    expect(deleteTokens).not.toHaveBeenCalled();
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("rejects ftp:// or other non-https schemes", async () => {
    const c = new TestConnector();
    c.oauthConfigOverride = {
      clientId: "id",
      tokenEndpoint: "ftp://attacker.example.com/grab",
    };
    c.setAuth({ token: "at", refreshToken: "rt-secret" });

    await c.callRefresh();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects an obviously malformed endpoint", async () => {
    const c = new TestConnector();
    c.oauthConfigOverride = {
      clientId: "id",
      tokenEndpoint: "not a url",
    };
    c.setAuth({ token: "at", refreshToken: "rt-secret" });

    await c.callRefresh();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepts an https:// endpoint", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "new-at", expires_in: 3600 }),
    });

    const result = await c.callRefresh();
    expect(result?.token).toBe("new-at");
  });
});

describe("MED-1: refreshToken validates the response body before adopting tokens", () => {
  it("returns null without persisting if access_token is missing", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}), // no access_token
    });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(storeTokens).not.toHaveBeenCalled();
    // Transient → keep existing tokens
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it("returns null if access_token is null", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: null }),
    });

    const result = await c.callRefresh();
    expect(result).toBeNull();
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("returns null if access_token is not a string", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 12345 }),
    });

    const result = await c.callRefresh();
    expect(result).toBeNull();
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("returns null if access_token is an empty string", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "" }),
    });

    const result = await c.callRefresh();
    expect(result).toBeNull();
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("clamps absurd expires_in values rather than persisting them", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new",
        expires_in: -3600, // negative — likely clock skew or buggy IdP
      }),
    });

    const result = await c.callRefresh();
    // Should NOT adopt a token whose expires_in is negative — implies
    // already-expired or junk IdP response. Treat as transient.
    expect(result).toBeNull();
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("rejects implausibly long expires_in (> 1 year)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new",
        expires_in: 60 * 60 * 24 * 365 * 10, // 10 years
      }),
    });

    const result = await c.callRefresh();
    expect(result).toBeNull();
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("accepts a valid response with no expires_in (some IdPs omit it)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "old", refreshToken: "rt" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "new-token" }),
    });

    const result = await c.callRefresh();
    expect(result?.token).toBe("new-token");
    expect(storeTokens).toHaveBeenCalledTimes(1);
  });
});
