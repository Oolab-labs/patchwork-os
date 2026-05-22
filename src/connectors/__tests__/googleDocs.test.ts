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
  extractDocumentId,
  getDocument,
  getDocumentText,
  getStatus,
  getValidAccessToken,
  handleDocsAuthRedirect,
  handleDocsCallback,
  handleDocsDisconnect,
  handleDocsTest,
  loadTokens,
  normalizeError,
} from "../googleDocs.js";

const ONE_HOUR = 60 * 60 * 1000;

function mockTokens(overrides: Record<string, unknown> = {}) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({
      access_token: "at_test",
      refresh_token: "rt_test",
      expiry_date: Date.now() + ONE_HOUR,
      connected_at: "2026-05-22T00:00:00.000Z",
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
  process.env.GOOGLE_DOCS_CLIENT_ID = "env_cid";
  process.env.GOOGLE_DOCS_CLIENT_SECRET = "env_csecret";
  process.env.PATCHWORK_TOKEN_DIR = path.join(
    os.tmpdir(),
    `patchwork-docs-test-${Date.now()}`,
  );
  process.env.PATCHWORK_HOME = process.env.PATCHWORK_TOKEN_DIR;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});

afterEach(() => {
  delete process.env.GOOGLE_DOCS_CLIENT_ID;
  delete process.env.GOOGLE_DOCS_CLIENT_SECRET;
  delete process.env.PATCHWORK_TOKEN_DIR;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  vi.restoreAllMocks();
});

describe("extractDocumentId", () => {
  it("extracts ID from /document/d/<id> URL", () => {
    expect(
      extractDocumentId("https://docs.google.com/document/d/abc123_-XYZ/edit"),
    ).toBe("abc123_-XYZ");
  });

  it("returns input unchanged when already a bare ID", () => {
    expect(extractDocumentId("abc123_-XYZ")).toBe("abc123_-XYZ");
  });
});

describe("normalizeError", () => {
  it("401 → auth_expired (non-retryable)", () => {
    const n = normalizeError(401, "expired");
    expect(n.kind).toBe("auth_expired");
    expect(n.retryable).toBe(false);
  });

  it("403 → permission_denied (non-retryable)", () => {
    expect(normalizeError(403, "nope").kind).toBe("permission_denied");
  });

  it("404 → not_found (non-retryable)", () => {
    const n = normalizeError(404, "gone");
    expect(n.kind).toBe("not_found");
    expect(n.retryable).toBe(false);
  });

  it("429 → rate_limited (retryable)", () => {
    const n = normalizeError(429, "");
    expect(n.kind).toBe("rate_limited");
    expect(n.retryable).toBe(true);
  });

  it("500 → provider_error (retryable)", () => {
    const n = normalizeError(503, "");
    expect(n.kind).toBe("provider_error");
    expect(n.retryable).toBe(true);
  });

  it("unmatched status → unknown_error", () => {
    expect(normalizeError(418, "tea").kind).toBe("unknown_error");
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
      id: "google-docs",
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
    mockTokens({ expiry_date: Date.now() - 1000, refresh_token: undefined });
    expect(getStatus().status).toBe("needs_reauth");
  });

  it("returns needs_reauth when expired, refresh present, but creds gone", () => {
    delete process.env.GOOGLE_DOCS_CLIENT_ID;
    delete process.env.GOOGLE_DOCS_CLIENT_SECRET;
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
      /Google Docs not connected/,
    );
  });

  it("returns token without refresh when not near expiry", async () => {
    mockTokens();
    expect(await getValidAccessToken()).toBe("at_test");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes within 60s expiry buffer", async () => {
    mockTokens({ expiry_date: Date.now() + 30_000 });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "at_refreshed", expires_in: 3600 }),
    );
    expect(await getValidAccessToken()).toBe("at_refreshed");
    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("env_cid");
  });

  it("throws when refresh fails with 400", async () => {
    mockTokens({ expiry_date: Date.now() - 1000 });
    mockFetch.mockResolvedValueOnce(textResponse("invalid_grant", false, 400));
    await expect(getValidAccessToken()).rejects.toThrow(
      /Token refresh failed.*400/,
    );
  });
});

describe("getDocument", () => {
  it("fetches doc tree from /v1/documents/{id}", async () => {
    mockTokens();
    const docPayload = {
      documentId: "doc-1",
      title: "Hello",
      body: { content: [] },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(docPayload));
    const out = await getDocument("doc-1");
    expect(out).toEqual(docPayload);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://docs.googleapis.com/v1/documents/doc-1");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer at_test",
    );
  });

  it("extracts ID from URL form", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({ documentId: "abc" }));
    await getDocument("https://docs.google.com/document/d/abc/edit");
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(url).toContain("/v1/documents/abc");
  });

  it("refreshes once on 401 then retries", async () => {
    mockTokens();
    mockFetch
      .mockResolvedValueOnce(textResponse("unauthorized", false, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "at_refreshed", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ documentId: "doc-1" }));
    const out = await getDocument("doc-1");
    expect(out).toEqual({ documentId: "doc-1" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // call[1] is the refresh; call[2] is the retry with the new token
    const [, retryInit] = mockFetch.mock.calls[2] as unknown as [
      string,
      RequestInit,
    ];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer at_refreshed",
    );
  });

  it("throws normalized message on non-2xx", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(textResponse("nope", false, 403));
    await expect(getDocument("doc-1")).rejects.toThrow(
      /Google Docs API error 403/,
    );
  });
});

describe("getDocumentText", () => {
  it("walks body.content paragraphs and joins textRun content", async () => {
    mockTokens();
    const docPayload = {
      documentId: "doc-1",
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: "Hello " } },
                { textRun: { content: "world\n" } },
              ],
            },
          },
          {
            paragraph: {
              elements: [{ textRun: { content: "Second line\n" } }],
            },
          },
        ],
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(docPayload));
    expect(await getDocumentText("doc-1")).toBe("Hello world\nSecond line\n");
  });

  it("returns '' when body content is empty", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({ documentId: "x" }));
    expect(await getDocumentText("x")).toBe("");
  });

  it("recurses into table cells", async () => {
    mockTokens();
    const docPayload = {
      documentId: "doc-1",
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        {
                          paragraph: {
                            elements: [{ textRun: { content: "cell1 " } }],
                          },
                        },
                      ],
                    },
                    {
                      content: [
                        {
                          paragraph: {
                            elements: [{ textRun: { content: "cell2" } }],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(docPayload));
    expect(await getDocumentText("doc-1")).toBe("cell1 cell2");
  });

  it("ignores paragraph elements without textRun", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        documentId: "x",
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { textRun: { content: "kept" } },
                  { startIndex: 1, endIndex: 2 },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(await getDocumentText("x")).toBe("kept");
  });
});

describe("handleDocsAuthRedirect", () => {
  it("returns 400 when client creds not configured", () => {
    delete process.env.GOOGLE_DOCS_CLIENT_ID;
    delete process.env.GOOGLE_DOCS_CLIENT_SECRET;
    const result = handleDocsAuthRedirect();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/CLIENT_ID/),
    });
  });

  it("returns 302 redirect with correct OAuth params + documents.readonly scope", () => {
    const result = handleDocsAuthRedirect();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(result.redirect).toContain("client_id=env_cid");
    expect(result.redirect).toContain("access_type=offline");
    expect(result.redirect).toContain("prompt=consent");
    expect(result.redirect).toMatch(/state=[a-f0-9]{64}/);
    expect(decodeURIComponent(result.redirect ?? "")).toContain(
      "https://www.googleapis.com/auth/documents.readonly",
    );
  });
});

describe("handleDocsCallback", () => {
  it("returns 400 when error param present", async () => {
    const result = await handleDocsCallback(null, null, "access_denied");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: false,
      error: "access_denied",
    });
  });

  it("returns 400 when state missing", async () => {
    const result = await handleDocsCallback("code", null, null);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Invalid OAuth state/);
  });

  it("returns 400 when state not pending (replay/forgery)", async () => {
    const result = await handleDocsCallback("code", "unknown-state", null);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Invalid OAuth state/);
  });

  it("completes auth flow with valid state from redirect", async () => {
    const auth = handleDocsAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    expect(state).not.toBe("");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at_new",
        refresh_token: "rt_new",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "documents.readonly",
      }),
    );
    const result = await handleDocsCallback("code", state, null);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ ok: true });
  });

  it("invalidates state after first use", async () => {
    const auth = handleDocsAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "at_new", expires_in: 3600 }),
    );
    await handleDocsCallback("code", state, null);
    const replay = await handleDocsCallback("code", state, null);
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.body).error).toMatch(/Invalid OAuth state/);
  });
});

describe("handleDocsTest", () => {
  it("returns 400 when not connected", async () => {
    const result = await handleDocsTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });

  it("returns 200 with email on tokeninfo success", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        email: "u@example.com",
        scope: "https://www.googleapis.com/auth/documents.readonly",
      }),
    );
    const result = await handleDocsTest();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      email: "u@example.com",
    });
  });

  it("returns 400 when tokeninfo errors", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401));
    const result = await handleDocsTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).ok).toBe(false);
  });
});

describe("handleDocsDisconnect", () => {
  it("returns 200 even when no tokens", async () => {
    const result = await handleDocsDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls Google revoke endpoint when access_token present", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const result = await handleDocsDisconnect();
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as unknown as [string];
    expect(url).toContain("oauth2.googleapis.com/revoke");
    expect(url).toContain("token=at_test");
  });

  it("still returns ok when revoke throws", async () => {
    mockTokens();
    mockFetch.mockRejectedValueOnce(new Error("network"));
    const result = await handleDocsDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });
});
