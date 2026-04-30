/**
 * BaseConnector — shared foundation for all Patchwork OS connectors.
 *
 * Provides:
 *   - Unified authentication flow (token refresh, expiry handling)
 *   - Secure token storage via OS keychain/DPAPI/Secret Service
 *   - OAuth 2.0 refresh token flow
 *   - Rate limiting with exponential backoff
 *   - Error normalization to ConnectorError type
 *   - Health check endpoint
 *
 * All new connectors (Jira, Notion, PagerDuty, Drive, etc.) extend this base.
 * Extracted to prevent "each connector reinvents auth" anti-pattern.
 */

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
  workspace?: string;
}

export interface AuthContext {
  token: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
}

export interface ConnectorError {
  code:
    | "auth_expired"
    | "rate_limited"
    | "not_found"
    | "permission_denied"
    | "validation_error"
    | "provider_error"
    | "network_error";
  message: string;
  providerDetail?: unknown;
  retryable: boolean;
  suggestedAction?: string;
}

export interface RateLimitState {
  remaining: number;
  resetAt: Date;
  backoffMs: number;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  scopes?: string[];
}

export abstract class BaseConnector {
  protected auth: AuthContext | null = null;
  protected rateLimit: RateLimitState = {
    remaining: 100,
    resetAt: new Date(Date.now() + 60000),
    backoffMs: 0,
  };
  protected oauthConfig: OAuthConfig | null = null;
  /**
   * In-flight refresh promise. When set, concurrent callers await the same
   * promise instead of POSTing to the IdP a second time. Cleared in `finally`
   * so the next caller (after success or failure) gets a fresh attempt.
   * Prevents double-refresh races where two concurrent 401s both burn the same
   * refresh token — fatal on IdPs that rotate refresh tokens (Google).
   */
  private refreshInflight: Promise<AuthContext | null> | null = null;

  abstract readonly providerName: string;

  /**
   * OAuth configuration for token refresh.
   * Subclasses should set this in their constructor for refresh to work.
   */
  protected abstract getOAuthConfig(): OAuthConfig | null;

  /**
   * Authenticate with the provider. Implemented by subclass.
   * Base class handles token refresh on expiry and secure storage.
   */
  abstract authenticate(): Promise<AuthContext>;

  /**
   * Load stored tokens from secure storage.
   * Call this in subclass constructor or connect method.
   */
  async loadStoredTokens(): Promise<boolean> {
    const { getTokens } = await import("./tokenStorage.js");
    const stored = await getTokens(this.providerName);
    if (stored) {
      this.auth = {
        token: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt ? new Date(stored.expiresAt) : undefined,
        scopes: stored.scopes,
      };
      return true;
    }
    return false;
  }

  /**
   * Save current tokens to secure storage.
   */
  async saveTokens(): Promise<void> {
    if (!this.auth) return;
    const { storeTokens } = await import("./tokenStorage.js");
    await storeTokens(this.providerName, {
      accessToken: this.auth.token,
      refreshToken: this.auth.refreshToken,
      expiresAt: this.auth.expiresAt?.toISOString(),
      scopes: this.auth.scopes,
    });
  }

  /**
   * Clear stored tokens (logout/disconnect).
   */
  async clearTokens(): Promise<void> {
    const { deleteTokens } = await import("./tokenStorage.js");
    await deleteTokens(this.providerName);
    this.auth = null;
  }

  /**
   * Perform OAuth 2.0 token refresh.
   * Subclasses can override for provider-specific refresh flows.
   *
   * Failure handling distinguishes permanent from transient failures:
   *   - Permanent (401, or 400 with `error: invalid_grant`) → clear stored
   *     tokens so the next call drives a fresh authenticate() flow.
   *   - Transient (network error, 5xx, 4xx without `invalid_grant`,
   *     misconfigured tokenEndpoint, malformed response body) → keep
   *     tokens; next call will retry. Avoids forcing a full re-OAuth on
   *     flaky wifi or temporary IdP outages.
   *
   * Security guarantees:
   *   - `tokenEndpoint` MUST be HTTPS — refresh tokens are never sent over
   *     plain HTTP, even if a buggy/hostile config supplies one.
   *   - The response is validated before adoption: `access_token` must be a
   *     non-empty string and `expires_in` (when present) must fall within
   *     [1s, 1 year]. Otherwise the existing tokens are kept and the result
   *     is treated as transient.
   */
  protected async refreshToken(): Promise<AuthContext | null> {
    if (!this.auth?.refreshToken) return null;

    const config = this.getOAuthConfig();
    if (!config) return null;

    // Refuse to send the refresh token to a non-HTTPS endpoint. A connector
    // subclass that derives `tokenEndpoint` from user-modifiable config
    // could otherwise be tricked into POSTing the secret to an attacker.
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(config.tokenEndpoint);
    } catch {
      return null;
    }
    if (endpointUrl.protocol !== "https:") {
      return null;
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.auth.refreshToken,
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    });

    let response: Response;
    try {
      response = await fetch(config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch {
      // Network error / DNS failure / timeout — transient, keep tokens
      return null;
    }

    if (!response.ok) {
      let errorBody: { error?: string } = {};
      try {
        errorBody = (await response.json()) as { error?: string };
      } catch {
        // Some IdPs return non-JSON error bodies; fall through with empty
      }
      const refreshTokenIsInvalid =
        response.status === 401 ||
        (response.status === 400 && errorBody.error === "invalid_grant");
      if (refreshTokenIsInvalid) {
        await this.clearTokens();
      }
      return null;
    }

    let data: {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      // Malformed success response — treat as transient
      return null;
    }

    // Validate the success body before adopting any of it. A 200 with
    // `{}` or `{access_token: null}` would otherwise persist `Bearer
    // undefined` to the OS keychain.
    if (
      typeof data.access_token !== "string" ||
      data.access_token.length === 0
    ) {
      return null;
    }
    let expiresAt: Date | undefined;
    if (data.expires_in !== undefined) {
      // Reject negative, zero, NaN, or absurdly long lifetimes (> 1 year).
      const ONE_YEAR_S = 60 * 60 * 24 * 365;
      const seconds = data.expires_in;
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > ONE_YEAR_S
      ) {
        return null;
      }
      expiresAt = new Date(Date.now() + seconds * 1000);
    }

    const newAuth: AuthContext = {
      token: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token.length > 0
          ? data.refresh_token
          : this.auth.refreshToken,
      expiresAt,
      scopes:
        typeof data.scope === "string"
          ? data.scope.split(" ")
          : (this.auth.scopes ?? undefined),
    };

    this.auth = newAuth;
    await this.saveTokens();
    return newAuth;
  }

  /**
   * Refresh the access token, deduplicating concurrent calls. Two callers
   * hitting an expired token simultaneously share the same refresh promise
   * instead of POSTing twice to the IdP. Critical for Google (refresh tokens
   * rotate on use — second concurrent refresh would invalidate the connector).
   *
   * The cache is cleared in `finally` so the next caller after settle (success
   * or failure) gets a fresh attempt. On refresh failure, all concurrent
   * waiters see the same rejection and the caller's normal auth-fallback path
   * (full re-authenticate) takes over.
   */
  protected refreshTokenDeduped(): Promise<AuthContext | null> {
    if (this.refreshInflight) return this.refreshInflight;
    this.refreshInflight = (async () => {
      try {
        return await this.refreshToken();
      } finally {
        this.refreshInflight = null;
      }
    })();
    return this.refreshInflight;
  }

  /**
   * Health check — validates token is valid without side effects.
   * Default implementation: make lightweight API call (e.g., /me or /user).
   */
  abstract healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }>;

  /**
   * Normalize provider-specific errors to ConnectorError.
   * Each subclass implements provider-specific error mapping.
   */
  abstract normalizeError(error: unknown): ConnectorError;

  /**
   * Get current connection status for dashboard.
   */
  abstract getStatus(): ConnectorStatus;

  /**
   * Execute an authenticated API call with automatic token refresh
   * and rate limit backoff.
   */
  protected async apiCall<T>(
    fn: (token: string) => Promise<T>,
    options: { retries?: number; retryDelayMs?: number } = {},
  ): Promise<{ data: T } | { error: ConnectorError }> {
    const { retries = 2, retryDelayMs = 1000 } = options;

    // Ensure auth - try refresh first, then fall back to full auth
    if (!this.auth || this.isTokenExpired()) {
      // Try OAuth refresh if we have a refresh token
      if (this.auth?.refreshToken) {
        const refreshed = await this.refreshTokenDeduped();
        if (refreshed) {
          this.auth = refreshed;
        } else {
          // Refresh failed, fall back to full auth
          try {
            this.auth = await this.authenticate();
          } catch (err) {
            return { error: this.normalizeError(err) };
          }
        }
      } else {
        // No refresh token, do full auth
        try {
          this.auth = await this.authenticate();
        } catch (err) {
          return { error: this.normalizeError(err) };
        }
      }
    }

    // After auth resolution above, this.auth is guaranteed non-null —
    // every "auth still null" branch returned an error and exited.
    // Narrow the type so `fn` gets a `string` instead of `string | undefined`.
    if (!this.auth) {
      return {
        error: {
          code: "provider_error",
          message: "auth resolution did not populate this.auth",
          retryable: false,
        },
      };
    }

    // Apply rate limit backoff. Clear it once the reset window has elapsed —
    // otherwise a single 429 with `Retry-After: 60` causes every subsequent
    // request to wait 60s indefinitely.
    if (this.rateLimit.backoffMs > 0) {
      const resetAt = this.rateLimit.resetAt?.getTime();
      if (resetAt && Date.now() >= resetAt) {
        this.rateLimit.backoffMs = 0;
      } else {
        await sleep(this.rateLimit.backoffMs);
        this.rateLimit.backoffMs = 0;
      }
    }

    // Execute with retry
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fn(this.auth.token);
        return { data: result };
      } catch (err) {
        const normalized = this.normalizeError(err);

        // Don't retry non-retryable errors
        if (!normalized.retryable || attempt === retries) {
          return { error: normalized };
        }

        // Exponential backoff with jitter
        const delay = retryDelayMs * 2 ** attempt + Math.random() * 500;
        await sleep(delay);

        // Token might have expired mid-call - try refresh first
        if (normalized.code === "auth_expired") {
          if (this.auth?.refreshToken) {
            const refreshed = await this.refreshTokenDeduped();
            if (refreshed) {
              this.auth = refreshed;
              continue; // Retry with new token
            }
          }
          // Refresh failed or no refresh token, try full auth
          try {
            this.auth = await this.authenticate();
          } catch {
            return { error: normalized };
          }
        }
      }
    }

    // Should not reach here, but TypeScript needs it
    return {
      error: {
        code: "provider_error",
        message: "Unexpected end of retry loop",
        retryable: false,
      },
    };
  }

  /**
   * Update rate limit state from HTTP response headers.
   * Subclass should call this after each API response.
   */
  protected updateRateLimitFromHeaders(headers: {
    "x-ratelimit-remaining"?: string;
    "x-ratelimit-reset"?: string;
    "retry-after"?: string;
  }): void {
    if (headers["x-ratelimit-remaining"]) {
      this.rateLimit.remaining = parseInt(headers["x-ratelimit-remaining"], 10);
    }
    if (headers["x-ratelimit-reset"]) {
      this.rateLimit.resetAt = new Date(
        parseInt(headers["x-ratelimit-reset"], 10) * 1000,
      );
    }
    if (headers["retry-after"]) {
      this.rateLimit.backoffMs = parseInt(headers["retry-after"], 10) * 1000;
    }
  }

  private isTokenExpired(): boolean {
    if (!this.auth?.expiresAt) return false;
    // Refresh 5 minutes before actual expiry
    return new Date(Date.now() + 5 * 60000) >= this.auth.expiresAt;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
