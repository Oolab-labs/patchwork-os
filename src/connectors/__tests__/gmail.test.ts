import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Override TOKEN_PATH via env before importing
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-gmail-"));
  process.env.GMAIL_CLIENT_ID = "test-client-id";
  process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
  process.env.PATCHWORK_HOME = tmp;
  process.env.PATCHWORK_TOKEN_DIR = path.join(tmp, "tokens");
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_DIR;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  vi.restoreAllMocks();
});

// Helper: write a token file into the test tmp dir
import { mkdirSync, writeFileSync } from "node:fs";

function writeTestTokens(dir: string, tokens: object) {
  mkdirSync(path.join(dir, "tokens"), { recursive: true });
  writeFileSync(
    path.join(dir, "tokens", "gmail.json"),
    JSON.stringify(tokens),
    { mode: 0o600 },
  );
}

describe("loadTokens", () => {
  it("migrates a legacy gmail token file into secure storage on read", async () => {
    const legacyTokens = {
      access_token: "legacy-access",
      refresh_token: "legacy-refresh",
      expiry_date: Date.now() + 60 * 60 * 1000,
      _client_id: "stored-cid",
      _client_secret: "stored-csecret",
    };

    writeTestTokens(tmp, legacyTokens);

    const { loadTokens } = await import("../gmail.js");

    expect(loadTokens()).toEqual(legacyTokens);
    expect(existsSync(path.join(tmp, "tokens", "gmail.json"))).toBe(false);
    expect(existsSync(path.join(tmp, "tokens", "patchwork-os.gmail.enc"))).toBe(
      true,
    );
  });
});

describe("handleConnectionsList", () => {
  it("returns disconnected when no token file exists", async () => {
    // Import fresh each test via dynamic import won't re-execute module-level
    // constants, so we test the exported functions directly with the token path
    // pointing at an empty tmp dir (no tokens subdir).
    const { handleConnectionsList } = await import("../gmail.js");
    const result = await handleConnectionsList();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as {
      connectors: Array<{ id: string; status: string }>;
    };
    expect(body.connectors[0]?.id).toBe("gmail");
    expect(body.connectors[0]?.status).toBe("disconnected");
  });
});

describe("handleGmailAuthRedirect", () => {
  it("returns 302 redirect to Google when configured", async () => {
    const { handleGmailAuthRedirect } = await import("../gmail.js");
    const result = handleGmailAuthRedirect();
    expect(result.status).toBe(302);
    expect(result.redirect).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(result.redirect).toContain("test-client-id");
    expect(result.redirect).toContain("gmail.readonly");
  });

  it("returns 503 when client ID not configured", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const { handleGmailAuthRedirect } = await import("../gmail.js");
    const result = handleGmailAuthRedirect();
    expect(result.status).toBe(503);
    expect(result.body).toContain("not configured");
  });
});

describe("handleGmailCallback", () => {
  it("returns 400 when error param present", async () => {
    const { handleGmailCallback } = await import("../gmail.js");
    const result = await handleGmailCallback(null, null, "access_denied");
    expect(result.status).toBe(400);
    expect(result.body).toContain("access_denied");
  });

  it("returns 400 when state is missing", async () => {
    const { handleGmailCallback } = await import("../gmail.js");
    const result = await handleGmailCallback("some-code", null, null);
    expect(result.status).toBe(400);
  });

  it("returns 400 when state is not in pending set", async () => {
    const { handleGmailCallback } = await import("../gmail.js");
    const result = await handleGmailCallback("code", "unknown-state", null);
    expect(result.status).toBe(400);
  });
});

describe("handleGmailDisconnect", () => {
  it("returns ok:true even when no token exists", async () => {
    const { handleGmailDisconnect } = await import("../gmail.js");
    const result = await handleGmailDisconnect();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ ok: true });
  });
});

describe("handleGmailTest", () => {
  it("returns error when not connected", async () => {
    const { handleGmailTest } = await import("../gmail.js");
    const result = await handleGmailTest();
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ ok: false });
  });
});
