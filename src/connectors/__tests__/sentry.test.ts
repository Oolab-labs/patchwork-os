import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  handleSentryDisconnect,
  handleSentryTest,
  loadTokens,
} from "../sentry.js";

const MOCK_TOKEN_FILE = {
  vendor: "sentry",
  client_id: "sclient",
  access_token: "tok",
  connected_at: "2026-04-20T00:00:00Z",
  profile: { org: "my-org" },
};

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
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKEN_FILE));
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.org).toBe("my-org");
  });
});

describe("loadTokens", () => {
  it("returns null when file missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadTokens()).toBeNull();
  });

  it("maps file access_token into auth_token shape", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKEN_FILE));
    const tokens = loadTokens();
    expect(tokens?.auth_token).toBe("tok");
    expect(tokens?.org).toBe("my-org");
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
});

describe("handleSentryDisconnect", () => {
  it("returns ok when no file", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handleSentryDisconnect();
    expect(result.status).toBe(200);
  });
});
