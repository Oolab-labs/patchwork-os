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
  getBoard,
  getItem,
  getStatus,
  getUpdates,
  getValidAccessToken,
  graphqlCall,
  handleMondayAuthRedirect,
  handleMondayCallback,
  handleMondayDisconnect,
  handleMondayTest,
  listBoards,
  listItems,
  loadTokens,
  me,
  normalizeError,
  normalizeGraphQLError,
  searchByName,
} from "../monday.js";

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
  process.env.MONDAY_CLIENT_ID = "env_cid";
  process.env.MONDAY_CLIENT_SECRET = "env_csecret";
  process.env.PATCHWORK_TOKEN_DIR = path.join(
    os.tmpdir(),
    `patchwork-monday-test-${Date.now()}`,
  );
  process.env.PATCHWORK_HOME = process.env.PATCHWORK_TOKEN_DIR;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});

afterEach(() => {
  delete process.env.MONDAY_CLIENT_ID;
  delete process.env.MONDAY_CLIENT_SECRET;
  delete process.env.PATCHWORK_TOKEN_DIR;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  vi.restoreAllMocks();
});

describe("normalizeError", () => {
  it("401 → auth_expired (non-retryable)", () => {
    const n = normalizeError(401, "expired");
    expect(n.kind).toBe("auth_expired");
    expect(n.retryable).toBe(false);
  });
  it("403 → permission_denied", () => {
    expect(normalizeError(403, "nope").kind).toBe("permission_denied");
  });
  it("404 → not_found", () => {
    expect(normalizeError(404, "").kind).toBe("not_found");
  });
  it("429 → rate_limited (retryable)", () => {
    const n = normalizeError(429, "");
    expect(n.kind).toBe("rate_limited");
    expect(n.retryable).toBe(true);
  });
  it("5xx → provider_error (retryable)", () => {
    expect(normalizeError(503, "").kind).toBe("provider_error");
    expect(normalizeError(503, "").retryable).toBe(true);
  });
  it("unmatched → unknown_error", () => {
    expect(normalizeError(418, "tea").kind).toBe("unknown_error");
  });
});

describe("normalizeGraphQLError", () => {
  it("'Unauthorized' → auth_expired", () => {
    expect(normalizeGraphQLError("Unauthorized request").kind).toBe(
      "auth_expired",
    );
  });
  it("'Invalid token' → auth_expired", () => {
    expect(normalizeGraphQLError("Invalid token provided").kind).toBe(
      "auth_expired",
    );
  });
  it("'forbidden' → permission_denied", () => {
    expect(normalizeGraphQLError("forbidden: scope missing").kind).toBe(
      "permission_denied",
    );
  });
  it("'rate limit' → rate_limited", () => {
    const n = normalizeGraphQLError("rate limit exceeded");
    expect(n.kind).toBe("rate_limited");
    expect(n.retryable).toBe(true);
  });
  it("unrelated → unknown_error", () => {
    expect(normalizeGraphQLError("boom").kind).toBe("unknown_error");
  });
});

describe("loadTokens", () => {
  it("returns null when no file present", () => {
    expect(loadTokens()).toBeNull();
  });
  it("returns parsed tokens when legacy file exists", () => {
    mockTokens({ email: "u@example.com", name: "U" });
    const t = loadTokens();
    expect(t).toMatchObject({
      access_token: "at_test",
      email: "u@example.com",
    });
  });
  it("returns null on invalid JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{ not json");
    expect(loadTokens()).toBeNull();
  });
});

describe("getStatus", () => {
  it("disconnected when no tokens", () => {
    expect(getStatus()).toMatchObject({ id: "monday", status: "disconnected" });
  });
  it("connected when token valid", () => {
    mockTokens({ name: "Alice", email: "a@x.com" });
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.name).toBe("Alice");
  });
  it("connected when expired but refresh + creds available", () => {
    mockTokens({ expiry_date: Date.now() - 1000 });
    expect(getStatus().status).toBe("connected");
  });
  it("needs_reauth when expired and no refresh token", () => {
    mockTokens({ expiry_date: Date.now() - 1000, refresh_token: undefined });
    expect(getStatus().status).toBe("needs_reauth");
  });
});

describe("getValidAccessToken", () => {
  it("throws when not connected", async () => {
    await expect(getValidAccessToken()).rejects.toThrow(/Monday not connected/);
  });
  it("returns token when not near expiry", async () => {
    mockTokens();
    expect(await getValidAccessToken()).toBe("at_test");
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it("refreshes inside 60s buffer", async () => {
    mockTokens({ expiry_date: Date.now() + 30_000 });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "at_refreshed", expires_in: 3600 }),
    );
    expect(await getValidAccessToken()).toBe("at_refreshed");
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(call0[1].body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("env_cid");
  });
});

describe("graphqlCall", () => {
  it("POSTs to api.monday.com/v2 with Bearer auth + JSON body", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { me: { id: "1" } } }),
    );
    await graphqlCall("{ me { id } }");
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call0[0]).toBe("https://api.monday.com/v2");
    expect(call0[1].method).toBe("POST");
    const headers = call0[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at_test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call0[1].body as string)).toMatchObject({
      query: "{ me { id } }",
    });
  });

  it("throws when GraphQL response has errors[] (HTTP 200)", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ message: "Field 'foo' doesn't exist" }] }),
    );
    await expect(graphqlCall("{ foo }")).rejects.toThrow(
      /Monday GraphQL error.*Field 'foo'/,
    );
  });

  it("maps 'Unauthorized' GraphQL error to auth_expired kind", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ message: "Unauthorized" }] }),
    );
    await expect(graphqlCall("{ me { id } }")).rejects.toThrow(/auth_expired/);
  });

  it("throws normalized HTTP error on non-2xx", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(textResponse("rate limited", false, 429));
    await expect(graphqlCall("{ me { id } }")).rejects.toThrow(
      /Monday API error 429/,
    );
  });

  it("refreshes once on 401 then retries with new token", async () => {
    mockTokens();
    mockFetch
      .mockResolvedValueOnce(textResponse("unauthorized", false, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "at_refreshed", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { me: { id: "1" } } }));
    const data = await graphqlCall<{ me: { id: string } }>("{ me { id } }");
    expect(data.me.id).toBe("1");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const retry = mockFetch.mock.calls[2] as unknown as [string, RequestInit];
    expect((retry[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer at_refreshed",
    );
  });
});

describe("query builders", () => {
  it("me() requests { me { id name email url } }", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { me: { id: "u1", name: "U", email: "u@x.com" } } }),
    );
    const u = await me();
    expect(u.id).toBe("u1");
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call0[1].body as string) as { query: string };
    expect(body.query).toContain("me {");
    expect(body.query).toContain("id name email url");
  });

  it("listBoards passes limit + orders by created_at", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { boards: [{ id: "b1", name: "Board 1" }] } }),
    );
    const out = await listBoards(25);
    expect(out).toHaveLength(1);
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call0[1].body as string) as {
      query: string;
      variables: { limit: number };
    };
    expect(body.variables.limit).toBe(25);
    expect(body.query).toContain("order_by: created_at");
  });

  it("getBoard requests columns + groups + items_count by id", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          boards: [
            {
              id: "b1",
              name: "B",
              columns: [{ id: "c1" }],
              groups: [{ id: "g1" }],
              items_count: 3,
            },
          ],
        },
      }),
    );
    const board = await getBoard("b1");
    expect(board?.items_count).toBe(3);
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call0[1].body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.variables.boardId).toBe("b1");
    expect(body.query).toContain("columns { id title type }");
    expect(body.query).toContain("groups { id title }");
    expect(body.query).toContain("items_count");
    expect(body.query).toContain("boards(ids: [$boardId])");
  });

  it("getBoard returns null when boards[] empty", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { boards: [] } }));
    expect(await getBoard("nope")).toBeNull();
  });

  it("listItems uses items_page + cursor", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          boards: [
            {
              items_page: { cursor: "cur2", items: [{ id: "i1", name: "I1" }] },
            },
          ],
        },
      }),
    );
    const page = await listItems("b1", 10, "cur1");
    expect(page.cursor).toBe("cur2");
    expect(page.items).toHaveLength(1);
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call0[1].body as string) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toMatchObject({
      boardId: "b1",
      limit: 10,
      cursor: "cur1",
    });
  });

  it("getItem returns first item with subitems + updates", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          items: [
            {
              id: "i1",
              name: "I",
              subitems: [{ id: "s1", name: "S" }],
              updates: [{ id: "u1", body: "hi" }],
            },
          ],
        },
      }),
    );
    const item = await getItem("i1");
    expect(item?.subitems?.[0]?.id).toBe("s1");
    expect(item?.updates?.[0]?.body).toBe("hi");
  });

  it("getUpdates returns updates array", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: { items: [{ updates: [{ id: "u1", body: "hello" }] }] },
      }),
    );
    const updates = await getUpdates("i1", 5);
    expect(updates).toHaveLength(1);
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call0[1].body as string) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables.limit).toBe(5);
  });

  it("searchByName builds rules filter on name column", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          boards: [
            {
              items_page: { cursor: null, items: [{ id: "i1", name: "Foo" }] },
            },
          ],
        },
      }),
    );
    const out = await searchByName("b1", "Foo");
    expect(out.items).toHaveLength(1);
    const call0 = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call0[1].body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('column_id: "name"');
    expect(body.query).toContain("operator: contains_text");
    expect(body.variables).toMatchObject({ boardId: "b1", query: "Foo" });
  });
});

describe("handleMondayAuthRedirect", () => {
  it("400 when client creds not configured", () => {
    delete process.env.MONDAY_CLIENT_ID;
    delete process.env.MONDAY_CLIENT_SECRET;
    const r = handleMondayAuthRedirect();
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false });
  });
  it("302 with full scope set in redirect URL", () => {
    const r = handleMondayAuthRedirect();
    expect(r.status).toBe(302);
    expect(r.redirect).toContain("auth.monday.com/oauth2/authorize");
    expect(r.redirect).toContain("client_id=env_cid");
    expect(r.redirect).toMatch(/state=[a-f0-9]{64}/);
    const decoded = decodeURIComponent(r.redirect ?? "");
    expect(decoded).toContain("me:read");
    expect(decoded).toContain("boards:read");
    expect(decoded).toContain("updates:read");
    expect(decoded).toContain("users:read");
    expect(decoded).toContain("tags:read");
  });
});

describe("handleMondayCallback", () => {
  it("400 when error param present", async () => {
    const r = await handleMondayCallback(null, null, "access_denied");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ error: "access_denied" });
  });
  it("400 when state missing", async () => {
    const r = await handleMondayCallback("c", null, null);
    expect(r.status).toBe(400);
  });
  it("400 on unknown state", async () => {
    const r = await handleMondayCallback("c", "nope", null);
    expect(JSON.parse(r.body).error).toMatch(/Invalid OAuth state/);
  });
  it("completes flow and captures name+email from me query", async () => {
    const auth = handleMondayAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "at_new",
          refresh_token: "rt_new",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { me: { id: "u1", name: "Alice", email: "a@x.com" } },
        }),
      );
    const r = await handleMondayCallback("code", state, null);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      ok: true,
      name: "Alice",
      email: "a@x.com",
    });
  });
  it("state cannot be replayed", async () => {
    const auth = handleMondayAuthRedirect();
    const state = /state=([a-f0-9]+)/.exec(auth.redirect ?? "")?.[1] ?? "";
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "at_new", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { me: { id: "u1" } } }));
    await handleMondayCallback("code", state, null);
    const replay = await handleMondayCallback("code", state, null);
    expect(replay.status).toBe(400);
  });
});

describe("handleMondayTest", () => {
  it("400 when not connected", async () => {
    const r = await handleMondayTest();
    expect(r.status).toBe(400);
  });
  it("200 with id/name/email on success", async () => {
    mockTokens();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { me: { id: "u1", name: "A", email: "a@x.com" } } }),
    );
    const r = await handleMondayTest();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, id: "u1" });
  });
});

describe("handleMondayDisconnect", () => {
  it("returns ok even with no tokens", async () => {
    const r = await handleMondayDisconnect();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
});
