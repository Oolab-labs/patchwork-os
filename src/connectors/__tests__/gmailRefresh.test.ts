/**
 * Tests that Gmail token refresh works using stored _client_id/_client_secret
 * when env vars are absent — reproducing the production bug where refreshes
 * failed silently if the bridge was restarted without credentials in env.
 */

import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import * as fs from "node:fs";
import { getValidAccessToken } from "../gmail.js";

function mockConnected(overrides: Record<string, unknown> = {}) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({
      access_token: "at_test",
      refresh_token: "rt_test",
      expiry_date: Date.now() + 60 * 60 * 1000,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  mockFetch.mockReset();
  process.env.GMAIL_CLIENT_ID = "env_cid";
  process.env.GMAIL_CLIENT_SECRET = "env_csecret";
  process.env.PATCHWORK_HOME = join(
    os.tmpdir(),
    `patchwork-gmail-refresh-${Date.now()}`,
  );
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});

afterEach(() => {
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  vi.restoreAllMocks();
});

describe("getValidAccessToken — credential fallback", () => {
  it("uses stored _client_id/_client_secret when env vars absent at refresh time", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;

    mockConnected({
      expiry_date: Date.now() - 1000,
      _client_id: "stored_cid",
      _client_secret: "stored_csecret",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at_refreshed", expires_in: 3600 }),
      text: async () => "{}",
    } as unknown as Response);

    const token = await getValidAccessToken();
    expect(token).toBe("at_refreshed");

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
    expect(body.get("client_id")).toBe("stored_cid");
    expect(body.get("client_secret")).toBe("stored_csecret");
    expect(body.get("refresh_token")).toBe("rt_test");
  });

  it("throws a clear error when token expired and no credentials anywhere", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    mockConnected({ expiry_date: Date.now() - 1000 });
    await expect(getValidAccessToken()).rejects.toThrow("reconnect");
  });

  it("prefers env vars over stored credentials when both present", async () => {
    mockConnected({
      expiry_date: Date.now() - 1000,
      _client_id: "stored_cid",
      _client_secret: "stored_csecret",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at_refreshed", expires_in: 3600 }),
      text: async () => "{}",
    } as unknown as Response);

    await getValidAccessToken();

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
    expect(body.get("client_id")).toBe("env_cid");
  });
});
