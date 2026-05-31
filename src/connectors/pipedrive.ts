/**
 * Pipedrive connector — read/write Pipedrive CRM via the Pipedrive REST API v1.
 *
 * Auth: API token (query param `api_token`).
 *   - Env var: PIPEDRIVE_API_TOKEN
 *   - Stored: getSecretJsonSync("pipedrive") → PipedriveTokens
 *
 * Base URL: https://{companyDomain}.pipedrive.com/api/v1
 *
 * Tools: getDeals, getDeal, createDeal, updateDeal, deleteDeal,
 *        getPersons, getPerson, createPerson,
 *        getOrganizations, createActivity,
 *        getPipelines, getStages
 *
 * Extends BaseConnector for unified auth, retry, rate-limit, error handling.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
} from "./baseConnector.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./tokenStorage.js";

export interface PipedriveTokens {
  apiToken: string;
  companyDomain: string;
  connected_at: string;
}

export interface PipedriveDeal {
  id: number;
  title: string;
  value: number | null;
  currency: string;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number | null;
  person_id: { value: number; name: string } | null;
  org_id: { value: number; name: string } | null;
  expected_close_date: string | null;
  add_time: string;
  update_time: string;
}

export interface PipedrivePerson {
  id: number;
  name: string;
  email: { value: string; primary: boolean }[];
  phone: { value: string; primary: boolean }[];
  org_id: { value: number; name: string } | null;
  add_time: string;
}

export interface PipedriveOrganization {
  id: number;
  name: string;
  address: string | null;
  people_count: number;
  add_time: string;
}

export interface PipedriveActivity {
  id: number;
  subject: string;
  type: string;
  due_date: string | null;
  due_time: string | null;
  deal_id: number | null;
  person_id: number | null;
  note: string | null;
  done: boolean;
  add_time: string;
}

export interface PipedrivePipeline {
  id: number;
  name: string;
  order_nr: number;
  active: boolean;
  add_time: string;
  update_time: string;
}

export interface PipedriveStage {
  id: number;
  name: string;
  pipeline_id: number;
  order_nr: number;
  active_flag: boolean;
  add_time: string;
  update_time: string;
}

// Pipedrive wraps all successful responses in { success: true, data: ... }
interface PipedriveResponse<T> {
  success: boolean;
  data: T;
  additional_data?: unknown;
  error?: string;
  error_info?: string;
}

export class PipedriveConnector extends BaseConnector {
  readonly providerName = "pipedrive";

  protected getOAuthConfig() {
    return null;
  }

  private baseUrl(): string {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Pipedrive not connected. Run: patchwork-os connect pipedrive or set PIPEDRIVE_API_TOKEN",
      );
    }
    return `https://${tokens.companyDomain}.pipedrive.com/api/v1`;
  }

  async authenticate(): Promise<AuthContext> {
    const tokens = loadTokens();
    if (!tokens) {
      throw new Error(
        "Pipedrive not connected. Run: patchwork-os connect pipedrive or set PIPEDRIVE_API_TOKEN",
      );
    }
    return {
      token: tokens.apiToken,
      scopes: ["read", "write"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    try {
      const result = await this.apiCall(async (token) => {
        const url = this.buildUrl("/users/me", token);
        const res = await fetch(url, { headers: this.buildHeaders() });
        if (!res.ok) throw res;
        return res.json();
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.normalizeError(err) };
    }
  }

  normalizeError(error: unknown): ConnectorError {
    if (error instanceof Response) {
      const s = error.status;
      if (s === 401)
        return {
          code: "auth_expired",
          message: "Pipedrive authentication expired — reconnect",
          retryable: false,
          suggestedAction: "patchwork-os connect pipedrive",
        };
      if (s === 403)
        return {
          code: "permission_denied",
          message: "Insufficient Pipedrive permissions",
          retryable: false,
        };
      if (s === 404)
        return {
          code: "not_found",
          message: "Pipedrive resource not found",
          retryable: false,
        };
      if (s === 429)
        return {
          code: "rate_limited",
          message: "Pipedrive API rate limit exceeded",
          retryable: true,
          suggestedAction: "Wait and retry",
        };
      if (s === 400)
        return {
          code: "validation_error",
          message: `Pipedrive validation error: HTTP ${s}`,
          retryable: false,
        };
      return {
        code: "provider_error",
        message: `Pipedrive API error: HTTP ${s}`,
        retryable: s >= 500,
      };
    }
    if (error instanceof Error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        return {
          code: "network_error",
          message: `Cannot connect to Pipedrive: ${error.message}`,
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
      id: "pipedrive",
      status: tokens ? "connected" : "disconnected",
      lastSync: tokens?.connected_at,
      workspace: tokens ? tokens.companyDomain : undefined,
    };
  }

  // ── API Methods ────────────────────────────────────────────────────────────

  async getDeals(
    params: {
      status?: "open" | "won" | "lost" | "deleted" | "all_not_deleted";
      start?: number;
      limit?: number;
    } = {},
  ): Promise<PipedriveDeal[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", params.status);
      if (params.start !== undefined) qs.set("start", String(params.start));
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      const url = this.buildUrl("/deals", token, qs);
      const res = await fetch(url, { headers: this.buildHeaders() });
      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedriveDeal[]>;
      return data.data ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveDeal[];
  }

  async getDeal(id: number): Promise<PipedriveDeal | null> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl(`/deals/${id}`, token);
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (res.status === 404) return null;
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedriveDeal>;
      return data.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveDeal | null;
  }

  async createDeal(params: {
    title: string;
    value?: number;
    currency?: string;
    stageId?: number;
    personId?: number;
    orgId?: number;
    status?: "open" | "won" | "lost";
    expectedCloseDate?: string;
  }): Promise<PipedriveDeal> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl("/deals", token);
      const body: Record<string, unknown> = { title: params.title };
      if (params.value !== undefined) body.value = params.value;
      if (params.currency) body.currency = params.currency;
      if (params.stageId !== undefined) body.stage_id = params.stageId;
      if (params.personId !== undefined) body.person_id = params.personId;
      if (params.orgId !== undefined) body.org_id = params.orgId;
      if (params.status) body.status = params.status;
      if (params.expectedCloseDate)
        body.expected_close_date = params.expectedCloseDate;
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedriveDeal>;
      return data.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveDeal;
  }

  async updateDeal(
    id: number,
    fields: Partial<{
      title: string;
      value: number;
      currency: string;
      stage_id: number;
      person_id: number;
      org_id: number;
      status: "open" | "won" | "lost";
      expected_close_date: string;
    }>,
  ): Promise<PipedriveDeal> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl(`/deals/${id}`, token);
      const res = await fetch(url, {
        method: "PUT",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedriveDeal>;
      return data.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveDeal;
  }

  async deleteDeal(id: number): Promise<void> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl(`/deals/${id}`, token);
      const res = await fetch(url, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      if (!res.ok) throw res;
      return null;
    });
    if ("error" in result) throw new Error(result.error.message);
  }

  async getPersons(
    params: { start?: number; limit?: number } = {},
  ): Promise<PipedrivePerson[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams();
      if (params.start !== undefined) qs.set("start", String(params.start));
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      const url = this.buildUrl("/persons", token, qs);
      const res = await fetch(url, { headers: this.buildHeaders() });
      this.updateRateLimitFromHeaders({
        "x-ratelimit-remaining":
          res.headers.get("x-ratelimit-remaining") ?? undefined,
        "retry-after": res.headers.get("retry-after") ?? undefined,
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedrivePerson[]>;
      return data.data ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedrivePerson[];
  }

  async getPerson(id: number): Promise<PipedrivePerson | null> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl(`/persons/${id}`, token);
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (res.status === 404) return null;
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedrivePerson>;
      return data.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedrivePerson | null;
  }

  async createPerson(params: {
    name: string;
    email?: string;
    phone?: string;
    orgId?: number;
  }): Promise<PipedrivePerson> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl("/persons", token);
      const body: Record<string, unknown> = { name: params.name };
      if (params.email) body.email = [{ value: params.email, primary: true }];
      if (params.phone) body.phone = [{ value: params.phone, primary: true }];
      if (params.orgId !== undefined) body.org_id = params.orgId;
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedrivePerson>;
      return data.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedrivePerson;
  }

  async getOrganizations(
    params: { start?: number; limit?: number } = {},
  ): Promise<PipedriveOrganization[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams();
      if (params.start !== undefined) qs.set("start", String(params.start));
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      const url = this.buildUrl("/organizations", token, qs);
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<
        PipedriveOrganization[]
      >;
      return data.data ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveOrganization[];
  }

  async createActivity(params: {
    subject: string;
    type: string;
    dueDate?: string;
    dueTime?: string;
    dealId?: number;
    personId?: number;
    note?: string;
  }): Promise<PipedriveActivity> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl("/activities", token);
      const body: Record<string, unknown> = {
        subject: params.subject,
        type: params.type,
      };
      if (params.dueDate) body.due_date = params.dueDate;
      if (params.dueTime) body.due_time = params.dueTime;
      if (params.dealId !== undefined) body.deal_id = params.dealId;
      if (params.personId !== undefined) body.person_id = params.personId;
      if (params.note) body.note = params.note;
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedriveActivity>;
      return data.data;
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveActivity;
  }

  async getPipelines(): Promise<PipedrivePipeline[]> {
    const result = await this.apiCall(async (token) => {
      const url = this.buildUrl("/pipelines", token);
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedrivePipeline[]>;
      return data.data ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedrivePipeline[];
  }

  async getStages(pipelineId?: number): Promise<PipedriveStage[]> {
    const result = await this.apiCall(async (token) => {
      const qs = new URLSearchParams();
      if (pipelineId !== undefined) qs.set("pipeline_id", String(pipelineId));
      const url = this.buildUrl("/stages", token, qs);
      const res = await fetch(url, { headers: this.buildHeaders() });
      if (!res.ok) throw res;
      const data = (await res.json()) as PipedriveResponse<PipedriveStage[]>;
      return data.data ?? [];
    });
    if ("error" in result) throw new Error(result.error.message);
    return result.data as PipedriveStage[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildUrl(
    path: string,
    token: string,
    extra?: URLSearchParams,
  ): string {
    const base = this.baseUrl();
    const qs = extra ? new URLSearchParams(extra) : new URLSearchParams();
    qs.set("api_token", token);
    return `${base}${path}?${qs.toString()}`;
  }

  private buildHeaders(): Record<string, string> {
    return { Accept: "application/json" };
  }
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify a Pipedrive v2 webhook signature.
 * Pipedrive sends HMAC-SHA256 of the raw body signed with your client secret,
 * delivered in the `x-pipedrive-signature` header.
 */
export function verifyPipedriveWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  clientSecret: string,
): boolean {
  if (!signatureHeader || !clientSecret) return false;
  try {
    const body =
      typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    const expected = createHmac("sha256", clientSecret)
      .update(body)
      .digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(signatureHeader, "utf8");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ── Token persistence ────────────────────────────────────────────────────────

export function loadTokens(): PipedriveTokens | null {
  const envToken = process.env.PIPEDRIVE_API_TOKEN;
  if (envToken) {
    return {
      apiToken: envToken,
      companyDomain: process.env.PIPEDRIVE_COMPANY_DOMAIN ?? "api",
      connected_at: new Date().toISOString(),
    };
  }
  return getSecretJsonSync<PipedriveTokens>("pipedrive");
}

export function saveTokens(tokens: PipedriveTokens): void {
  storeSecretJsonSync("pipedrive", tokens);
}

export function clearTokens(): void {
  try {
    deleteSecretJsonSync("pipedrive");
  } catch {
    // ignore
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _instance: PipedriveConnector | null = null;

function resetPipedriveConnector(): void {
  _instance = null;
}

export function getPipedriveConnector(): PipedriveConnector {
  if (!_instance) {
    _instance = new PipedriveConnector();
  }
  return _instance;
}

export { getPipedriveConnector as pipedrive };

// ── HTTP Handlers ────────────────────────────────────────────────────────────
// Wired in src/server.ts under /connections/pipedrive/*

export interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * POST /connections/pipedrive/connect  { apiToken, companyDomain }
 */
export async function handlePipedriveConnect(
  body: string,
): Promise<ConnectorHandlerResult> {
  let apiToken: string;
  let companyDomain: string;

  try {
    const parsed = JSON.parse(body) as {
      apiToken?: unknown;
      companyDomain?: unknown;
    };
    if (typeof parsed.apiToken !== "string" || !parsed.apiToken) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "apiToken is required" }),
      };
    }
    if (typeof parsed.companyDomain !== "string" || !parsed.companyDomain) {
      return {
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "companyDomain is required" }),
      };
    }
    apiToken = parsed.apiToken;
    companyDomain = parsed.companyDomain;
  } catch {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  try {
    const baseUrl = `https://${companyDomain}.pipedrive.com/api/v1`;
    const res = await fetch(`${baseUrl}/users/me?api_token=${apiToken}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `Credentials rejected by Pipedrive (HTTP ${res.status}) — check apiToken and companyDomain`,
        }),
      };
    }
    const details = (await res.json()) as PipedriveResponse<{
      id: number;
      name: string;
      email: string;
    }>;

    const tokens: PipedriveTokens = {
      apiToken,
      companyDomain,
      connected_at: new Date().toISOString(),
    };
    saveTokens(tokens);
    resetPipedriveConnector();

    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userId: details.data?.id,
        userName: details.data?.name,
        companyDomain,
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
 * POST /connections/pipedrive/test
 */
export async function handlePipedriveTest(): Promise<ConnectorHandlerResult> {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Pipedrive not connected" }),
    };
  }
  try {
    const connector = getPipedriveConnector();
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
 * DELETE /connections/pipedrive
 */
export function handlePipedriveDisconnect(): ConnectorHandlerResult {
  clearTokens();
  resetPipedriveConnector();
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  };
}
