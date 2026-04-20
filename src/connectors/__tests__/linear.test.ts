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
  handleLinearDisconnect,
  handleLinearTest,
  loadTokens,
} from "../linear.js";

const MOCK_TOKEN_FILE = {
  vendor: "linear",
  client_id: "client-abc",
  access_token: "acc-xyz",
  connected_at: "2026-04-20T00:00:00.000Z",
  profile: { workspace: "acme" },
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

  it("maps file access_token into api_key shape", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKEN_FILE));
    const tokens = loadTokens();
    expect(tokens?.api_key).toBe("acc-xyz");
    expect(tokens?.workspace).toBe("acme");
  });

  it("returns env-var token without file", () => {
    process.env.LINEAR_API_KEY = "lin_api_from_env";
    const tokens = loadTokens();
    expect(tokens?.api_key).toBe("lin_api_from_env");
  });
});

describe("getStatus", () => {
  it("returns disconnected when no tokens", () => {
    const s = getStatus();
    expect(s.status).toBe("disconnected");
    expect(s.id).toBe("linear");
  });

  it("returns connected when token file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_TOKEN_FILE));
    const s = getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toBe("acme");
  });
});

describe("handleLinearTest", () => {
  it("returns 400 when not connected", async () => {
    const result = await handleLinearTest();
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { ok: boolean; error: string };
    expect(body.error).toContain("not connected");
  });
});

describe("handleLinearDisconnect", () => {
  it("returns ok even when no file", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await handleLinearDisconnect();
    expect(result.status).toBe(200);
  });
});
