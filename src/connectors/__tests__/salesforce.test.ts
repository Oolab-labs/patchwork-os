import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import * as fs from "node:fs";
import {
  createRecord,
  describeObject,
  getObject,
  getStatus,
  handleSalesforceAuthRedirect,
  handleSalesforceCallback,
  handleSalesforceDisconnect,
  handleSalesforceTest,
  healthCheck,
  loadTokens,
  normalizeError,
  query,
  searchSosl,
  updateRecord,
} from "../salesforce.js";

const INSTANCE_URL = "https://example-org.my.salesforce.com";

function mockTokens(overrides: Record<string, unknown> = {}) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({
      access_token: "at_test",
      refresh_token: "rt_test",
      instance_url: INSTANCE_URL,
      connected_at: "2026-05-22T00:00:00.000Z",
      _client_id: "stored_cid",
      _client_secret: "stored_csecret",
      _login_host: "login.salesforce.com",
      ...overrides,
    }),
  );
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => text,
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue("{}");
  mockFetch.mockReset();
  process.env.SALESFORCE_CLIENT_ID = "env_cid";
  process.env.SALESFORCE_CLIENT_SECRET = "env_csecret";
  delete process.env.SALESFORCE_LOGIN_HOST;
  process.env.PATCHWORK_TOKEN_DIR = path.join(
    os.tmpdir(),
    `patchwork-sf-test-${Date.now()}`,
  );
  process.env.PATCHWORK_HOME = process.env.PATCHWORK_TOKEN_DIR;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});

afterEach(() => {
  delete process.env.SALESFORCE_CLIENT_ID;
  delete process.env.SALESFORCE_CLIENT_SECRET;
  delete process.env.SALESFORCE_LOGIN_HOST;
  delete process.env.PATCHWORK_TOKEN_DIR;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  vi.restoreAllMocks();
});

describe("normalizeError", () => {
  it("401 → auth_expired and surfaces INVALID_SESSION_ID code", () => {
    const body = JSON.stringify([
      {
        message: "Session expired or invalid",
        errorCode: "INVALID_SESSION_ID",
      },
    ]);
    const n = normalizeError(401, body);
    expect(n.kind).toBe("auth_expired");
    expect(n.retryable).toBe(false);
    expect(n.message).toContain("INVALID_SESSION_ID");
    expect(n.message).toContain("Session expired or invalid");
  });

  it("403 → permission_denied with errorCode prefix", () => {
    const body = JSON.stringify([
      { message: "insufficient access", errorCode: "INSUFFICIENT_ACCESS" },
    ]);
    const n = normalizeError(403, body);
    expect(n.kind).toBe("permission_denied");
    expect(n.message).toContain("INSUFFICIENT_ACCESS");
  });

  it("404 → not_found", () => {
    expect(normalizeError(404, "").kind).toBe("not_found");
  });

  it("429 → rate_limited and retryable", () => {
    const n = normalizeError(429, "");
    expect(n.kind).toBe("rate_limited");
    expect(n.retryable).toBe(true);
  });

  it("500 → provider_error retryable", () => {
    const n = normalizeError(503, "");
    expect(n.kind).toBe("provider_error");
    expect(n.retryable).toBe(true);
  });

  it("falls back to raw body when body is not JSON", () => {
    const n = normalizeError(401, "not-json");
    expect(n.kind).toBe("auth_expired");
    expect(n.message).toBe("not-json");
  });

  it("unmatched status → unknown_error", () => {
    expect(normalizeError(418, "tea").kind).toBe("unknown_error");
  });
});

describe("loadTokens", () => {
  it("returns null when no file present", () => {
    expect(loadTokens()).toBeNull();
  });

  it("returns parsed tokens including instance_url", () => {
    mockTokens({ username: "u@example.com" });
    const t = loadTokens();
    expect(t).toMatchObject({
      access_token: "at_test",
      instance_url: INSTANCE_URL,
      username: "u@example.com",
    });
  });
});

describe("getStatus", () => {
  it("returns disconnected when no tokens", () => {
    expect(getStatus()).toMatchObject({
      id: "salesforce",
      status: "disconnected",
    });
  });

  it("returns connected with instance_url", () => {
    mockTokens({ username: "u@example.com" });
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.instanceUrl).toBe(INSTANCE_URL);
    expect(s.username).toBe("u@example.com");
  });

  it("returns needs_reauth when stored expiry passed and no refresh creds", () => {
    delete process.env.SALESFORCE_CLIENT_ID;
    delete process.env.SALESFORCE_CLIENT_SECRET;
    mockTokens({
      expiry_date: Date.now() - 1000,
      _client_id: undefined,
      _client_secret: undefined,
      refresh_token: undefined,
    });
    expect(getStatus().status).toBe("needs_reauth");
  });
});

describe("handleSalesforceAuthRedirect", () => {
  it("returns 400 when client creds not configured", () => {
    delete process.env.SALESFORCE_CLIENT_ID;
    delete process.env.SALESFORCE_CLIENT_SECRET;
    const result = handleSalesforceAuthRedirect();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ ok: false });
  });

  it("redirects to login.salesforce.com by default", () => {
    const result = handleSalesforceAuthRedirect();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain(
      "https://login.salesforce.com/services/oauth2/authorize",
    );
    expect(result.redirect).toContain("client_id=env_cid");
    expect(result.redirect).toContain("response_type=code");
    // URLSearchParams encodes spaces as '+' so check the raw form.
    expect(result.redirect).toContain("scope=api+refresh_token+offline_access");
    expect(result.redirect).toMatch(/state=[a-f0-9]{64}/);
  });

  it("honours SALESFORCE_LOGIN_HOST env override (sandbox)", () => {
    process.env.SALESFORCE_LOGIN_HOST = "test.salesforce.com";
    const result = handleSalesforceAuthRedirect();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain(
      "https://test.salesforce.com/services/oauth2/authorize",
    );
  });

  // audit 2026-06-10 connectors-vendors-1: SALESFORCE_LOGIN_HOST must be
  // allowlisted. An attacker-controlled host would otherwise receive the
  // client_secret + auth code at the token-exchange endpoint.
  it("rejects a non-allowlisted SALESFORCE_LOGIN_HOST (SSRF / credential redirect)", () => {
    process.env.SALESFORCE_LOGIN_HOST = "attacker.example.com";
    const result = handleSalesforceAuthRedirect();
    expect(result.status).toBe(400);
    const parsed = JSON.parse(result.body) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/SALESFORCE_LOGIN_HOST/);
    // The malicious host must never be interpolated into a redirect URL.
    expect(result.redirect).toBeUndefined();
  });

  it("allows a *.my.salesforce.com My Domain login host", () => {
    process.env.SALESFORCE_LOGIN_HOST = "acme.my.salesforce.com";
    const result = handleSalesforceAuthRedirect();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain(
      "https://acme.my.salesforce.com/services/oauth2/authorize",
    );
  });
});

describe("handleSalesforceCallback", () => {
  it("returns 400 on provider error param", async () => {
    const result = await handleSalesforceCallback(null, null, "access_denied");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: "access_denied" });
  });

  it("returns 400 on unknown state", async () => {
    const result = await handleSalesforceCallback("c", "nope", null);
    expect(result.status).toBe(400);
  });

  it("persists instance_url from token response on successful exchange", async () => {
    const auth = handleSalesforceAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    expect(state).not.toBe("");
    const newInstance = "https://acme-9.my.salesforce.com";
    mockFetch
      // 1) token exchange — returns instance_url
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "at_new",
          refresh_token: "rt_new",
          instance_url: newInstance,
          id: "https://login.salesforce.com/id/00D000000000000EAA/00500000000000XAAA",
          token_type: "Bearer",
          issued_at: "1700000000000",
        }),
      )
      // 2) identity lookup (best-effort) — returns user info
      .mockResolvedValueOnce(
        jsonResponse({
          username: "agent@acme.com",
          display_name: "Agent Smith",
          organization_id: "00D000000000000EAA",
        }),
      );

    const result = await handleSalesforceCallback("code", state, null);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.instance_url).toBe(newInstance);
    expect(parsed.username).toBe("agent@acme.com");

    // Verify the token-exchange call used the env-configured login host.
    const [tokenUrl] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(tokenUrl).toBe("https://login.salesforce.com/services/oauth2/token");
  });

  it("rejects token responses missing instance_url", async () => {
    const auth = handleSalesforceAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at_new",
        refresh_token: "rt_new",
        // instance_url MISSING
      }),
    );
    const result = await handleSalesforceCallback("code", state, null);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/instance_url/);
  });
});

describe("query (SOQL)", () => {
  it("rejects non-SELECT statements", async () => {
    mockTokens();
    await expect(query("DELETE FROM Account")).rejects.toThrow(
      /must start with SELECT/,
    );
    await expect(query("UPDATE Account SET Name='x'")).rejects.toThrow(
      /must start with SELECT/,
    );
    await expect(
      query("INSERT INTO Account (Name) VALUES ('x')"),
    ).rejects.toThrow(/must start with SELECT/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("issues GET against /services/data/v59.0/query with bearer auth", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ totalSize: 1, done: true, records: [{ Id: "001" }] }),
    );
    const out = await query("SELECT Id FROM Account");
    expect(out.records).toEqual([{ Id: "001" }]);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain(`${INSTANCE_URL}/services/data/v59.0/query?q=`);
    expect(url).toContain("LIMIT%20200");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer at_test",
    );
  });

  it("keeps user LIMIT clause when supplied", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ totalSize: 0, done: true, records: [] }),
    );
    await query("SELECT Id FROM Account LIMIT 5");
    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    // Should not append a second LIMIT
    const limitCount = (url.match(/LIMIT/gi) ?? []).length;
    expect(limitCount).toBe(1);
  });
});

describe("searchSosl", () => {
  it("rejects queries not starting with FIND", async () => {
    mockTokens();
    await expect(searchSosl("SELECT Id FROM Account")).rejects.toThrow(
      /must start with FIND/,
    );
  });

  it("issues GET against /search when valid", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({ searchRecords: [] }));
    await searchSosl("FIND {acme} IN ALL FIELDS");
    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`${INSTANCE_URL}/services/data/v59.0/search?q=`);
  });
});

describe("getObject / describeObject", () => {
  it("rejects malformed object names (path-traversal defence)", async () => {
    mockTokens();
    await expect(getObject("../bad", "001000000000000")).rejects.toThrow(
      /Invalid sObject/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed record IDs", async () => {
    mockTokens();
    await expect(getObject("Account", "not-an-id")).rejects.toThrow(
      /Invalid record id/,
    );
  });

  it("GETs the sObject endpoint for a valid id", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({ Id: "001000000000000" }));
    await getObject("Account", "001000000000000");
    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `${INSTANCE_URL}/services/data/v59.0/sobjects/Account/001000000000000`,
    );
  });

  it("describeObject hits /describe", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({ fields: [] }));
    await describeObject("Account");
    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/sobjects/Account/describe");
  });
});

describe("createRecord / updateRecord", () => {
  it("createRecord POSTs JSON body", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: "001abc", success: true, errors: [] }),
    );
    const r = await createRecord("Account", { Name: "Acme" });
    expect(r.success).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/sobjects/Account");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(init.body).toBe(JSON.stringify({ Name: "Acme" }));
  });

  it("updateRecord PATCHes JSON body", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, true, 204));
    const r = await updateRecord("Account", "001000000000000", { Name: "X" });
    expect(r.ok).toBe(true);
    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("PATCH");
  });
});

describe("refresh-on-401", () => {
  it("refreshes once on 401 then retries with the new token", async () => {
    mockTokens();
    mockFetch
      // 1) original request → 401
      .mockResolvedValueOnce(
        textResponse(
          JSON.stringify([{ errorCode: "INVALID_SESSION_ID", message: "x" }]),
          false,
          401,
        ),
      )
      // 2) refresh token call → new access_token
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "at_refreshed",
          instance_url: INSTANCE_URL,
        }),
      )
      // 3) retry → success
      .mockResolvedValueOnce(
        jsonResponse({ totalSize: 0, done: true, records: [] }),
      );
    await query("SELECT Id FROM Account");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [refreshUrl, refreshInit] = mockFetch.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(refreshUrl).toBe(
      "https://login.salesforce.com/services/oauth2/token",
    );
    const body = new URLSearchParams(refreshInit.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_test");
    // 3rd call uses the refreshed bearer
    const [, retryInit] = mockFetch.mock.calls[2] as unknown as [
      string,
      RequestInit,
    ];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer at_refreshed",
    );
  });
});

describe("healthCheck", () => {
  it("returns ok:false when not connected", async () => {
    const r = await healthCheck();
    expect(r.ok).toBe(false);
  });

  it("hits /services/data/<v>/ with bearer", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse([{ version: "59.0" }]));
    const r = await healthCheck();
    expect(r.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${INSTANCE_URL}/services/data/v59.0/`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer at_test",
    );
  });
});

describe("handleSalesforceTest", () => {
  it("returns 400 when not connected", async () => {
    const result = await handleSalesforceTest();
    expect(result.status).toBe(400);
  });
});

describe("handleSalesforceDisconnect", () => {
  it("returns 200 even when nothing stored", async () => {
    const result = await handleSalesforceDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls revoke endpoint on stored login host", async () => {
    mockTokens({ _login_host: "test.salesforce.com" });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await handleSalesforceDisconnect();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(url).toContain("https://test.salesforce.com/services/oauth2/revoke");
    expect(url).toContain("token=at_test");
  });
});
