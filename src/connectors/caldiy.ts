/**
 * Cal.diy connector — scheduling via Cal.com-compatible API.
 *
 * Auth: API key (Personal Access Token).
 *   - Env var: CALCOM_API_KEY overrides stored token for CI/headless use.
 *   - Stored: getSecretJsonSync("caldiy") → CalDiyTokens
 *
 * Cal.diy is the MIT-licensed self-hostable fork of Cal.com; the API is
 * identical to Cal.com cloud. Defaults to https://api.cal.com/v2 but
 * accepts a custom baseUrl for self-hosted deployments.
 *
 * Tools: getEventTypes, getEventType, getBookings, getBooking,
 *        cancelBooking, rescheduleBooking, getMeUser, getSchedules,
 *        createSchedule
 *
 * Webhook verification: verifyCalDiyWebhook (HMAC-SHA256, x-cal-signature-256)
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import { getSecretJsonSync, storeSecretJsonSync } from "./tokenStorage.js";

const CALDIY_DEFAULT_BASE_URL = "https://api.cal.com/v2";
const CALDIY_API_VERSION = "2024-09-04";

// ------------------------------------------------------------------ token types

export interface CalDiyTokens {
  apiKey: string;
  baseUrl: string;
  username?: string;
  connected_at: string;
}

// ------------------------------------------------------------------ API types

export interface CalEventType {
  id: number;
  slug: string;
  title: string;
  description?: string;
  length: number;
  hidden: boolean;
  locations?: unknown[];
  bookingFields?: unknown[];
}

export interface CalBookingAttendee {
  name: string;
  email: string;
  timeZone: string;
}

export interface CalBooking {
  uid: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  status: string;
  attendees: CalBookingAttendee[];
  eventType?: CalEventType;
  cancelledBy?: string;
  rescheduledBy?: string;
}

export interface CalUser {
  id: number;
  username: string;
  email: string;
  name: string;
  timeZone: string;
  weekStart: string;
}

export interface CalSchedule {
  id: number;
  name: string;
  timeZone: string;
  isDefault?: boolean;
  availability?: unknown[];
}

// ------------------------------------------------------------------ token helpers

export function loadTokens(): CalDiyTokens | null {
  const envKey = process.env.CALCOM_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: CALDIY_DEFAULT_BASE_URL,
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<CalDiyTokens>("caldiy");
}

export function saveTokens(tokens: CalDiyTokens): void {
  storeSecretJsonSync("caldiy", tokens);
}

export function clearTokens(): void {
  try {
    const p = path.join(homedir(), ".patchwork", "tokens", "caldiy.json");
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------------ webhook verification

/**
 * Verify a Cal.diy webhook signature.
 *
 * Cal.com sends `x-cal-signature-256: <hex>` computed as HMAC-SHA256 over
 * the raw request body using the webhook secret.
 *
 * Returns true only when the signature matches; returns false on any
 * mismatch or malformed input. Never throws.
 */
export function verifyCalDiyWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  webhookSecret: string,
): boolean {
  try {
    const bodyBuf =
      typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    const expected = createHmac("sha256", webhookSecret)
      .update(bodyBuf)
      .digest("hex");
    const actual = signatureHeader.trim().toLowerCase();
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(actual, "utf8");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ connector

export class CalDiyConnector extends BaseConnector {
  readonly providerName = "caldiy";
  protected cachedTokens: CalDiyTokens | null = null;

  protected getOAuthConfig() {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Cal.diy not connected. Run: patchwork connect caldiy  or set CALCOM_API_KEY",
      );
    }
    this.cachedTokens = tokens;
    return { token: tokens.apiKey };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const baseUrl = this.baseUrl();
        const res = await fetch(`${baseUrl}/me`, {
          headers: this.buildHeaders(token),
        });
        if (!res.ok)
          throw Object.assign(new Error(`HTTP ${res.status}`), {
            status: res.status,
          });
        return res.json() as Promise<{ status: string; data: CalUser }>;
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error && typeof error === "object" && "status" in error) {
      const status = (error as { status: number }).status;
      if (status === 401)
        return {
          code: "auth_expired",
          message: "Cal.diy API key expired or invalid",
          retryable: false,
          suggestedAction: "Reconnect: patchwork connect caldiy",
        };
      if (status === 429)
        return {
          code: "rate_limited",
          message: "Cal.diy API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      if (status === 404)
        return {
          code: "not_found",
          message: "Cal.diy resource not found",
          retryable: false,
        };
      if (status === 400)
        return {
          code: "validation_error",
          message: "Cal.diy request validation failed",
          retryable: false,
        };
      return {
        code: "provider_error",
        message: `Cal.diy API error: HTTP ${status}`,
        retryable: status >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot reach Cal.diy API: ${error.message}`,
          retryable: true,
        };
      }
    }
    return {
      code: "provider_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    const tokens = loadTokens();
    return {
      id: "caldiy",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens?.username,
    };
  }

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "cal-api-version": CALDIY_API_VERSION,
    };
  }

  private baseUrl(): string {
    const tokens = this.cachedTokens ?? loadTokens();
    return tokens?.baseUrl ?? CALDIY_DEFAULT_BASE_URL;
  }

  private async get<T>(apiPath: string): Promise<T> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${this.baseUrl()}${apiPath}`, {
        headers: this.buildHeaders(token),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<{ status: string; data: T }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { status: string; data: T }).data;
  }

  private async post<T>(apiPath: string, body: unknown): Promise<T> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${this.baseUrl()}${apiPath}`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<{ status: string; data: T }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { status: string; data: T }).data;
  }

  private async del<T>(apiPath: string, body?: unknown): Promise<T> {
    const result = await this.apiCall(async (token) => {
      const res = await fetch(`${this.baseUrl()}${apiPath}`, {
        method: "DELETE",
        headers: this.buildHeaders(token),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw Object.assign(new Error(err.message ?? `HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return res.json() as Promise<{ status: string; data: T }>;
    });
    if ("error" in result) throw new Error(result.error.message);
    return (result.data as { status: string; data: T }).data;
  }

  // ---------------------------------------------------------------- tools

  async getEventTypes(): Promise<CalEventType[]> {
    return this.get<CalEventType[]>("/event-types");
  }

  async getEventType(id: number): Promise<CalEventType> {
    return this.get<CalEventType>(`/event-types/${id}`);
  }

  async getBookings(opts?: {
    status?: string;
    attendeeEmail?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<CalBooking[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.attendeeEmail) params.set("attendeeEmail", opts.attendeeEmail);
    if (opts?.dateFrom) params.set("dateFrom", opts.dateFrom);
    if (opts?.dateTo) params.set("dateTo", opts.dateTo);
    const qs = params.toString();
    return this.get<CalBooking[]>(`/bookings${qs ? `?${qs}` : ""}`);
  }

  async getBooking(uid: string): Promise<CalBooking> {
    return this.get<CalBooking>(`/bookings/${uid}`);
  }

  async cancelBooking(uid: string, reason?: string): Promise<{ uid: string }> {
    return this.del<{ uid: string }>(
      `/bookings/${uid}`,
      reason !== undefined ? { reason } : undefined,
    );
  }

  async rescheduleBooking(
    uid: string,
    startTime: string,
    reason?: string,
  ): Promise<CalBooking> {
    const body: Record<string, string> = { startTime };
    if (reason !== undefined) body.reason = reason;
    return this.post<CalBooking>(`/bookings/${uid}/reschedule`, body);
  }

  async getMeUser(): Promise<CalUser> {
    return this.get<CalUser>("/me");
  }

  async getSchedules(): Promise<CalSchedule[]> {
    return this.get<CalSchedule[]>("/schedules");
  }

  async createSchedule(
    name: string,
    timeZone: string,
    availability?: unknown[],
  ): Promise<CalSchedule> {
    const body: Record<string, unknown> = { name, timeZone };
    if (availability !== undefined) body.availability = availability;
    return this.post<CalSchedule>("/schedules", body);
  }
}

// ------------------------------------------------------------------ singleton

let _instance: CalDiyConnector | null = null;

export function getCalDiyConnector(): CalDiyConnector {
  if (!_instance) _instance = new CalDiyConnector();
  return _instance;
}

export function resetCalDiyConnector(): void {
  _instance = null;
}

// ------------------------------------------------------------------ convenience re-exports

export { loadTokens as isConnected };

// ------------------------------------------------------------------ HTTP handlers
// Wired in src/server.ts under /connections/caldiy/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/caldiy/connect  { apiKey: "cal_...", baseUrl?: "..." }
 * Stores the API key and verifies it by calling GET /me.
 */
export async function handleCalDiyConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiKey: string;
  let baseUrl: string;
  try {
    const parsed = JSON.parse(body) as { apiKey?: unknown; baseUrl?: unknown };
    if (typeof parsed.apiKey !== "string" || parsed.apiKey.trim() === "") {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            "apiKey is required. Generate one at your Cal.diy dashboard under Settings → API Keys.",
        }),
      };
    }
    apiKey = parsed.apiKey.trim();
    baseUrl =
      typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() !== ""
        ? parsed.baseUrl.trim()
        : CALDIY_DEFAULT_BASE_URL;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const res = await fetch(`${baseUrl}/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "cal-api-version": CALDIY_API_VERSION,
      },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "API key rejected by Cal.diy — check the key is valid",
        }),
      };
    }
    const wrapped = (await res.json()) as { status: string; data: CalUser };
    const user = wrapped.data;
    const tokens: CalDiyTokens = {
      apiKey,
      baseUrl,
      username: user.username,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetCalDiyConnector();
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        username: tokens.username ?? "unknown",
        connectedAt: tokens.connected_at,
      }),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * POST /connections/caldiy/test
 * Verifies stored API key is still valid.
 */
export async function handleCalDiyTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Cal.diy not connected" }),
    };
  }
  try {
    const connector = getCalDiyConnector();
    const check = await connector.healthCheck();
    return {
      status: check.ok ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        check.ok ? { ok: true } : { ok: false, error: check.error?.message },
      ),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * DELETE /connections/caldiy
 * Removes stored token.
 */
export function handleCalDiyDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetCalDiyConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
