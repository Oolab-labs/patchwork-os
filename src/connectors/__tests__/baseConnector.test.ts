/**
 * Direct unit tests for BaseConnector.refreshToken() and the auto-refresh
 * paths inside apiCall(). Subclassed via TestConnector so we can drive the
 * abstract surface without dragging in a real provider.
 *
 * Why: gmailRefresh.test.ts only exercises Gmail's overridden refresh path;
 * none of the Wave-2 connectors (zendesk, stripe, intercom, hubspot, datadog)
 * have refresh-flow tests. Cover the base class so the contract that all of
 * them inherit is locked in before more connectors ship.
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

  authenticateImpl: () => Promise<AuthContext> = async () => {
    throw new Error("authenticate not configured by test");
  };

  protected getOAuthConfig(): OAuthConfig | null {
    return {
      clientId: "test-client",
      clientSecret: "test-secret",
      tokenEndpoint: "https://oauth.example.com/token",
    };
  }

  async authenticate(): Promise<AuthContext> {
    return this.authenticateImpl();
  }

  async healthCheck() {
    return { ok: true };
  }

  normalizeError(err: unknown): ConnectorError {
    if (err instanceof Error && err.message === "EXPIRED") {
      return {
        code: "auth_expired",
        message: "expired",
        retryable: true,
      };
    }
    if (err instanceof Error && err.message === "RETRYABLE") {
      return {
        code: "provider_error",
        message: "retryable",
        retryable: true,
      };
    }
    return {
      code: "provider_error",
      message: err instanceof Error ? err.message : "unknown",
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    return { id: this.providerName, status: "connected" };
  }

  // Test seam — populate auth without going through authenticate()
  setAuth(auth: AuthContext | null) {
    this.auth = auth;
  }

  callRefresh() {
    return this.refreshToken();
  }

  callApi<T>(fn: (token: string) => Promise<T>, retries?: number) {
    return this.apiCall(fn, { retries, retryDelayMs: 1 });
  }
}

class NoConfigConnector extends TestConnector {
  protected getOAuthConfig(): OAuthConfig | null {
    return null;
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

describe("BaseConnector.refreshToken()", () => {
  it("returns null when no refresh token is present", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old" });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it("returns null when no OAuth config is available", async () => {
    const c = new NoConfigConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_test" });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts refresh_token grant and persists new tokens on success", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_old" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "at_new",
        refresh_token: "rt_new",
        expires_in: 3600,
        scope: "read write",
      }),
    });

    const result = await c.callRefresh();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://oauth.example.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_old");
    expect(body.get("client_id")).toBe("test-client");
    expect(body.get("client_secret")).toBe("test-secret");

    expect(result?.token).toBe("at_new");
    expect(result?.refreshToken).toBe("rt_new");
    expect(result?.scopes).toEqual(["read", "write"]);
    expect(result?.expiresAt).toBeInstanceOf(Date);
    // expiresAt should be ~3600s in the future (allow 5s skew)
    const driftMs = result!.expiresAt!.getTime() - Date.now() - 3600_000;
    expect(Math.abs(driftMs)).toBeLessThan(5_000);

    expect(storeTokens).toHaveBeenCalledTimes(1);
    expect(storeTokens).toHaveBeenCalledWith("test-provider", {
      accessToken: "at_new",
      refreshToken: "rt_new",
      expiresAt: result!.expiresAt!.toISOString(),
      scopes: ["read", "write"],
    });
  });

  it("preserves the existing refresh token when the response omits one", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_keep" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at_new", expires_in: 60 }),
    });

    const result = await c.callRefresh();

    expect(result?.token).toBe("at_new");
    expect(result?.refreshToken).toBe("rt_keep");
  });

  it("clears stored tokens on 401 (refresh token revoked)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_revoked" });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_token" }),
    });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(deleteTokens).toHaveBeenCalledWith("test-provider");
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("clears stored tokens on 400 invalid_grant (refresh token expired/revoked)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_expired" });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(deleteTokens).toHaveBeenCalledWith("test-provider");
  });

  it("preserves stored tokens on transient 5xx (server error)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_test" });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: "service_unavailable" }),
    });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it("preserves stored tokens on network error (transient)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_test" });
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it("preserves stored tokens on 400 without invalid_grant (likely misconfig)", async () => {
    const c = new TestConnector();
    c.setAuth({ token: "at_old", refreshToken: "rt_test" });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_request" }),
    });

    const result = await c.callRefresh();

    expect(result).toBeNull();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it("omits client_secret when not configured (public client)", async () => {
    class PublicClient extends TestConnector {
      protected getOAuthConfig(): OAuthConfig | null {
        return {
          clientId: "public-cid",
          tokenEndpoint: "https://oauth.example.com/token",
        };
      }
    }
    const c = new PublicClient();
    c.setAuth({ token: "at_old", refreshToken: "rt_old" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at_new" }),
    });

    await c.callRefresh();

    const body = new URLSearchParams(
      mockFetch.mock.calls[0]![1].body as string,
    );
    expect(body.has("client_secret")).toBe(false);
    expect(body.get("client_id")).toBe("public-cid");
  });
});

describe("BaseConnector.apiCall() refresh integration", () => {
  it("refreshes preemptively when token is expired before the call", async () => {
    const c = new TestConnector();
    c.setAuth({
      token: "at_expired",
      refreshToken: "rt_test",
      expiresAt: new Date(Date.now() - 1000),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at_fresh", expires_in: 3600 }),
    });

    const fnSpy = vi.fn(async (token: string) => `ok:${token}`);
    const result = await c.callApi(fnSpy);

    expect(mockFetch).toHaveBeenCalledTimes(1); // refresh
    expect(fnSpy).toHaveBeenCalledTimes(1);
    expect(fnSpy).toHaveBeenCalledWith("at_fresh");
    expect(result).toEqual({ data: "ok:at_fresh" });
  });

  it("falls back to full re-auth when refresh fails", async () => {
    const c = new TestConnector();
    c.setAuth({
      token: "at_expired",
      refreshToken: "rt_revoked",
      expiresAt: new Date(Date.now() - 1000),
    });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    c.authenticateImpl = vi
      .fn()
      .mockResolvedValue({ token: "at_reauth" } satisfies AuthContext);

    const fnSpy = vi.fn(async (token: string) => `ok:${token}`);
    const result = await c.callApi(fnSpy);

    expect(c.authenticateImpl).toHaveBeenCalledTimes(1);
    expect(fnSpy).toHaveBeenCalledWith("at_reauth");
    expect(result).toEqual({ data: "ok:at_reauth" });
  });

  it("retries with fresh token when call fails mid-flight with auth_expired", async () => {
    const c = new TestConnector();
    // expiresAt > 5min in the future so the *preemptive* refresh path is skipped;
    // we want to exercise the mid-call refresh that runs from the catch block.
    c.setAuth({
      token: "at_old",
      refreshToken: "rt_test",
      expiresAt: new Date(Date.now() + 600_000),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "at_new", expires_in: 3600 }),
    });

    let calls = 0;
    const fn = async (token: string) => {
      calls++;
      if (calls === 1) throw new Error("EXPIRED");
      return `ok:${token}`;
    };

    const result = await c.callApi(fn, 2);

    expect(calls).toBe(2);
    expect(result).toEqual({ data: "ok:at_new" });
  });
});
