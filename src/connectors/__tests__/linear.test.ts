import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import * as fs from "node:fs";
import {
  getStatus,
  handleLinearConnect,
  handleLinearDisconnect,
  handleLinearTest,
  loadTokens,
} from "../linear.js";

const MOCK_TOKENS = {
  api_key: "lin_api_test123",
  workspace: "acme",
  connected_at: "2026-01-01T00:00:00.000Z",
};

const VIEWER_RESPONSE = {
  data: {
    viewer: {
      id: "user1",
      name: "Test User",
      email: "test@acme.com",
      organization: { name: "Acme", urlKey: "acme" },
    },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LINEAR_API_KEY;
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

afterEach(() => {
  delete process.env.LINEAR_API_KEY;
});

describe("loadTokens", () => {
  it("returns null when no file and no env var", () => {
    expect(loadTokens()).toBeNull();
  });

  it("reads tokens from file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKENS));
    const tokens = loadTokens();
    expect(tokens?.api_key).toBe("lin_api_test123");
    expect(tokens?.workspace).toBe("acme");
  });

  it("returns env-var token without file", () => {
    process.env.LINEAR_API_KEY = "lin_api_from_env";
    const tokens = loadTokens();
    expect(tokens?.api_key).toBe("lin_api_from_env");
  });

  it("returns null on malformed JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not-json");
    expect(loadTokens()).toBeNull();
  });
});

describe("getStatus", () => {
  it("returns disconnected when no tokens", () => {
    const s = getStatus();
    expect(s.status).toBe("disconnected");
    expect(s.id).toBe("linear");
  });

  it("returns connected when tokens present", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKENS));
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toBe("acme");
  });
});

describe("handleLinearConnect", () => {
  it("returns 400 when api_key missing", async () => {
    const result = await handleLinearConnect({});
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("api_key");
  });

  it("verifies token and saves on success", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => VIEWER_RESPONSE,
    } as Response);

    const result = await handleLinearConnect({ api_key: "lin_api_test" });
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as {
      ok: boolean;
      name: string;
      workspace: string;
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Test User");
    expect(body.workspace).toBe("acme");
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce();
  });

  it("returns 400 on API error", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    const result = await handleLinearConnect({ api_key: "bad_key" });
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});

describe("handleLinearTest", () => {
  it("returns 400 when not connected", async () => {
    const result = await handleLinearTest();
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { ok: boolean; error: string };
    expect(body.error).toContain("not connected");
  });

  it("returns ok when token valid", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKENS));
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => VIEWER_RESPONSE,
    } as Response);

    const result = await handleLinearTest();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Test User");
  });
});

describe("handleLinearDisconnect", () => {
  it("deletes tokens file when exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = handleLinearDisconnect();
    expect(result.status).toBe(200);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledOnce();
  });

  it("returns ok even when no file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = handleLinearDisconnect();
    expect(result.status).toBe(200);
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });
});
