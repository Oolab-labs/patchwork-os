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
   */
  protected async refreshToken(): Promise<AuthContext | null> {
    if (!this.auth?.refreshToken) return null;

    const config = this.getOAuthConfig();
    if (!config) return null;

    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.auth.refreshToken,
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      });

      const response = await fetch(config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      const newAuth: AuthContext = {
        token: data.access_token,
        refreshToken: data.refresh_token ?? this.auth.refreshToken,
        expiresAt: data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000)
          : undefined,
        scopes: data.scope?.split(" ") ?? this.auth.scopes,
      };

      this.auth = newAuth;
      await this.saveTokens();
      return newAuth;
    } catch {
      // Refresh failed - clear tokens to force re-auth
      await this.clearTokens();
      return null;
    }
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
        const refreshed = await this.refreshToken();
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

    // Apply rate limit backoff
    if (this.rateLimit.backoffMs > 0) {
      await sleep(this.rateLimit.backoffMs);
    }

    // Execute with retry
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fn(this.auth?.token);
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
            const refreshed = await this.refreshToken();
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
