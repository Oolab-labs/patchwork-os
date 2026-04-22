/**
 * BaseConnector — shared foundation for all Patchwork OS connectors.
 *
 * Provides:
 *   - Unified authentication flow (token refresh, expiry handling)
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

export abstract class BaseConnector {
  protected auth: AuthContext | null = null;
  protected rateLimit: RateLimitState = {
    remaining: 100,
    resetAt: new Date(Date.now() + 60000),
    backoffMs: 0,
  };

  abstract readonly providerName: string;

  /**
   * Authenticate with the provider. Implemented by subclass.
   * Base class handles token refresh on expiry.
   */
  abstract authenticate(): Promise<AuthContext>;

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

    // Ensure auth
    if (!this.auth || this.isTokenExpired()) {
      try {
        this.auth = await this.authenticate();
      } catch (err) {
        return {
          error: this.normalizeError(err),
        };
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

        // Token might have expired mid-call
        if (normalized.code === "auth_expired") {
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
