import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock filesystem and fetch before importing the connector
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import * as fs from "node:fs";
import {
  getStatus,
  handleSentryConnect,
  handleSentryDisconnect,
  handleSentryTest,
  loadTokens,
} from "../sentry.js";

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getStatus", () => {
  it("returns disconnected when no token file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(getStatus().status).toBe("disconnected");
  });

  it("returns connected when token file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        auth_token: "tok",
        connected_at: "2026-04-20T00:00:00Z",
      }),
    );
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.lastSync).toBe("2026-04-20T00:00:00Z");
  });
});

describe("loadTokens", () => {
  it("returns null when file missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadTokens()).toBeNull();
  });

  it("returns parsed tokens when file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        auth_token: "mytoken",
        org: "my-org",
        connected_at: "2026-04-20T00:00:00Z",
      }),
    );
    const tokens = loadTokens();
    expect(tokens?.auth_token).toBe("mytoken");
    expect(tokens?.org).toBe("my-org");
  });
});

describe("handleSentryConnect", () => {
  it("rejects missing auth_token", async () => {
    const result = await handleSentryConnect({});
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/auth_token/);
  });

  it("stores token and returns ok on successful verify", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: { username: "alice" } }),
    });
    const result = await handleSentryConnect({
      auth_token: "valid-token",
      org: "my-org",
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.username).toBe("alice");
    expect(body.org).toBe("my-org");
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
  });

  it("returns 400 when Sentry API rejects the token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => "Unauthorized",
    });
    const result = await handleSentryConnect({ auth_token: "bad-token" });
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/401|Sentry API error/i);
  });
});

describe("handleSentryTest", () => {
  it("returns 400 when not connected", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handleSentryTest();
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(false);
  });

  it("returns ok when connected and token valid", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        auth_token: "tok",
        connected_at: "2026-04-20T00:00:00Z",
      }),
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: { username: "bob" } }),
    });
    const result = await handleSentryTest();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(true);
    expect(body.username).toBe("bob");
  });
});

describe("handleSentryDisconnect", () => {
  it("deletes token file and returns ok", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = handleSentryDisconnect();
    expect(result.status).toBe(200);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });
});
