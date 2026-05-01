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
  extractFileId,
  fetchDocContent,
  fetchDocName,
  getStatus,
  getValidAccessToken,
  handleDriveAuthRedirect,
  handleDriveCallback,
  handleDriveDisconnect,
  handleDriveTest,
  loadTokens,
} from "../googleDrive.js";

const ONE_HOUR = 60 * 60 * 1000;

function mockTokens(overrides: Record<string, unknown> = {}) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({
      access_token: "at_test",
      refresh_token: "rt_test",
      expiry_date: Date.now() + ONE_HOUR,
      connected_at: "2026-04-30T00:00:00.000Z",
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
  process.env.GOOGLE_DRIVE_CLIENT_ID = "env_cid";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "env_csecret";
  process.env.PATCHWORK_TOKEN_DIR = path.join(
    os.tmpdir(),
    `patchwork-drive-test-${Date.now()}`,
  );
  process.env.PATCHWORK_HOME = process.env.PATCHWORK_TOKEN_DIR;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});

afterEach(() => {
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  delete process.env.PATCHWORK_TOKEN_DIR;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  vi.restoreAllMocks();
});

describe("extractFileId", () => {
  it("extracts ID from /d/<id> URL", () => {
    expect(
      extractFileId("https://docs.google.com/document/d/abc123_-XYZ/edit"),
    ).toBe("abc123_-XYZ");
  });

  it("returns input unchanged when already a bare ID", () => {
    expect(extractFileId("abc123_-XYZ")).toBe("abc123_-XYZ");
  });
});

describe("loadTokens", () => {
  it("returns null when no file present", () => {
    expect(loadTokens()).toBeNull();
  });

  it("returns parsed tokens when legacy file exists", () => {
    mockTokens({ email: "u@example.com" });
    const tokens = loadTokens();
    expect(tokens).toMatchObject({
      access_token: "at_test",
      refresh_token: "rt_test",
      email: "u@example.com",
    });
  });

  it("returns null when file content is invalid JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{ not json");
    expect(loadTokens()).toBeNull();
  });
});

describe("getStatus", () => {
  it("returns disconnected when no tokens", () => {
    expect(getStatus()).toMatchObject({
      id: "google-drive",
      status: "disconnected",
    });
  });

  it("returns connected when token still valid", () => {
    mockTokens({ email: "u@example.com" });
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.email).toBe("u@example.com");
  });

  it("returns connected when expired but refresh available", () => {
    mockTokens({ expiry_date: Date.now() - 1000 });
    expect(getStatus().status).toBe("connected");
  });

  it("returns needs_reauth when expired and no refresh token", () => {
    mockTokens({
      expiry_date: Date.now() - 1000,
      refresh_token: undefined,
    });
    expect(getStatus().status).toBe("needs_reauth");
  });

  it("returns needs_reauth when expired, has refresh, but creds missing", () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    mockTokens({
      expiry_date: Date.now() - 1000,
      _client_id: undefined,
      _client_secret: undefined,
    });
    expect(getStatus().status).toBe("needs_reauth");
  });
});

describe("getValidAccessToken", () => {
  it("throws when not connected", async () => {
    await expect(getValidAccessToken()).rejects.toThrow(
      /Google Drive not connected/,
    );
  });

  it("returns access token without refresh when not near expiry", async () => {
    mockTokens(); // expiry_date = now + 1h, refresh buffer is 60s
    const token = await getValidAccessToken();
    expect(token).toBe("at_test");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes when within 60s expiry buffer", async () => {
    mockTokens({ expiry_date: Date.now() + 30_000 }); // inside 60s buffer
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at_refreshed",
        expires_in: 3600,
      }),
    );
    const token = await getValidAccessToken();
    expect(token).toBe("at_refreshed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_test");
    expect(body.get("client_id")).toBe("env_cid");
    expect(body.get("client_secret")).toBe("env_csecret");
  });

  it("refreshes when expiry_date is missing entirely", async () => {
    mockTokens({ expiry_date: undefined });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "at_refreshed", expires_in: 3600 }),
    );
    expect(await getValidAccessToken()).toBe("at_refreshed");
  });

  it("falls back to stored _client_id/_client_secret when env absent", async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    mockTokens({
      expiry_date: Date.now() - 1000,
      _client_id: "stored_cid",
      _client_secret: "stored_csecret",
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "at_refreshed", expires_in: 3600 }),
    );
    await getValidAccessToken();
    const body = new URLSearchParams(
      mockFetch.mock.calls[0]?.[1].body as string,
    );
    expect(body.get("client_id")).toBe("stored_cid");
    expect(body.get("client_secret")).toBe("stored_csecret");
  });

  it("throws when refresh_token missing and expired", async () => {
    mockTokens({
      expiry_date: Date.now() - 1000,
      refresh_token: undefined,
    });
    await expect(getValidAccessToken()).rejects.toThrow(/No refresh token/);
  });

  it("throws when refresh succeeds-then-fails (server 400)", async () => {
    mockTokens({ expiry_date: Date.now() - 1000 });
    mockFetch.mockResolvedValueOnce(textResponse("invalid_grant", false, 400));
    await expect(getValidAccessToken()).rejects.toThrow(
      /Token refresh failed.*400/,
    );
  });

  it("throws clear error when no creds anywhere at refresh time", async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    mockTokens({ expiry_date: Date.now() - 1000 });
    await expect(getValidAccessToken()).rejects.toThrow(
      /client credentials.*reconnect/,
    );
  });
});

describe("fetchDocContent", () => {
  it("prefers Markdown export when available", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("# Hello\n\n- [ ] task"));
    const out = await fetchDocContent("file_xyz", "tok");
    expect(out).toContain("# Hello");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("mimeType=text%2Fmarkdown");
    expect(url).toContain("file_xyz");
  });

  it("falls back to text/plain when Markdown export 404s", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse("nope", false, 404))
      .mockResolvedValueOnce(textResponse("Plain text body"));
    const out = await fetchDocContent("file_xyz", "tok");
    expect(out).toBe("Plain text body");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url2] = mockFetch.mock.calls[1] as [string];
    expect(url2).toContain("mimeType=text%2Fplain");
  });

  it("falls back to plain when Markdown is empty/whitespace", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse("   \n  "))
      .mockResolvedValueOnce(textResponse("real content"));
    expect(await fetchDocContent("file", "tok")).toBe("real content");
  });

  it('returns "" when both exports fail', async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse("", false, 403))
      .mockResolvedValueOnce(textResponse("", false, 403));
    expect(await fetchDocContent("file", "tok")).toBe("");
  });

  it("caps payload at 50KB", async () => {
    const huge = "x".repeat(60 * 1024);
    mockFetch.mockResolvedValueOnce(textResponse(huge));
    const out = await fetchDocContent("file", "tok");
    expect(out.length).toBe(50 * 1024);
  });

  it("sends Bearer authorization header", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("ok"));
    await fetchDocContent("file", "secret-tok");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-tok",
    );
  });
});

describe("fetchDocName", () => {
  it("returns name from Drive API", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ name: "My Doc" }));
    expect(await fetchDocName("file", "tok")).toBe("My Doc");
  });

  it('returns "" when API returns non-OK', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));
    expect(await fetchDocName("file", "tok")).toBe("");
  });

  it('returns "" when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    expect(await fetchDocName("file", "tok")).toBe("");
  });
});

describe("handleDriveAuthRedirect", () => {
  it("returns 400 when client creds not configured", () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    const result = handleDriveAuthRedirect();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/CLIENT_ID/),
    });
  });

  it("returns 302 redirect with correct OAuth params", () => {
    const result = handleDriveAuthRedirect();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(result.redirect).toContain("client_id=env_cid");
    expect(result.redirect).toContain("access_type=offline");
    expect(result.redirect).toContain("prompt=consent");
    expect(result.redirect).toMatch(/state=[a-f0-9]{64}/);
    expect(result.redirect).toContain("drive.readonly");
  });
});

describe("handleDriveCallback", () => {
  it("returns 400 when error param present", async () => {
    const result = await handleDriveCallback(null, null, "access_denied");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      error: "access_denied",
    });
  });

  it("returns 400 when state missing", async () => {
    const result = await handleDriveCallback("code", null, null);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Invalid OAuth state/);
  });

  it("returns 400 when state not pending (replay/forgery)", async () => {
    const result = await handleDriveCallback("code", "unknown-state", null);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Invalid OAuth state/);
  });

  it("completes auth flow with valid state from redirect", async () => {
    const auth = handleDriveAuthRedirect();
    const stateMatch = /state=([a-f0-9]+)/.exec(auth.redirect ?? "");
    const state = stateMatch?.[1] ?? "";
    expect(state).not.toBe("");

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at_new",
        refresh_token: "rt_new",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "drive.readonly",
      }),
    );

    const result = await handleDriveCallback("code", state, null);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ ok: true });
  });

  it("returns 400 when token exchange fails", async () => {
    const auth = handleDriveAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    mockFetch.mockResolvedValueOnce(textResponse("bad_code", false, 400));
    const result = await handleDriveCallback("code", state, null);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Token exchange failed/);
  });

  it("invalidates state after successful use (single-use)", async () => {
    const auth = handleDriveAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "at_new", expires_in: 3600 }),
    );
    await handleDriveCallback("code", state, null);
    // Second use of same state must fail
    const replay = await handleDriveCallback("code", state, null);
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.body).error).toMatch(/Invalid OAuth state/);
  });
});

describe("handleDriveTest", () => {
  it("returns 400 when not connected", async () => {
    const result = await handleDriveTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 with email on Drive API success", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ user: { emailAddress: "u@example.com" } }),
    );
    const result = await handleDriveTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      email: "u@example.com",
    });
  });

  it("returns 400 when Drive API errors", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401));
    const result = await handleDriveTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      error: expect.stringContaining("401"),
    });
  });
});

describe("handleDriveDisconnect", () => {
  it("returns 200 even when no tokens", async () => {
    const result = await handleDriveDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls Google revoke endpoint when access_token present", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const result = await handleDriveDisconnect();
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("oauth2.googleapis.com/revoke");
    expect(url).toContain("token=at_test");
  });

  it("still returns ok when revoke fetch throws", async () => {
    mockTokens();
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    const result = await handleDriveDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });
});
