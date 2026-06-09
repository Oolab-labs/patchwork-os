/**
 * Audit 2026-06-09 HIGH (connector-new-1 / connector-new-2): PR #947 fixed the
 * token-exchange raw-IdP-body credential leak in mcpOAuth.ts ONLY. The identical
 * pattern — `const body = await res.text(); throw new Error(\`... ${body}\`)` —
 * survived in six independent connectors whose callback handlers surface the
 * thrown Error message verbatim into the HTTP response (HTML for discord/asana/
 * gitlab, JSON for monday/googleDocs/googleDrive).
 *
 * Some IdP error bodies embed an access_token / refresh_token / error_description
 * that can contain secrets — so the raw body must never reach the thrown Error or
 * the HTTP response. Only the HTTP status (and a parsed `error` code) is safe.
 *
 * Each case drives the real authorize→callback flow with a leaky 400 response and
 * asserts the secret tokens are absent from the response body while the status is
 * still surfaced for diagnosis.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LEAK_TOKEN = "LEAKED_SECRET_TOKEN_0001";
const LEAKY_JSON_BODY = JSON.stringify({
  error: "invalid_grant",
  error_description: "secretdetail-should-not-leak",
  access_token: LEAK_TOKEN,
  refresh_token: "REFRESH_LEAK_9999",
});

function leakyFetch() {
  return vi.fn().mockResolvedValue(
    new Response(LEAKY_JSON_BODY, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function stateFromRedirect(redirect: string | undefined): string {
  const url = new URL(redirect ?? "");
  const state = url.searchParams.get("state");
  if (!state) throw new Error("authorize produced no state");
  return state;
}

function assertNoLeak(body: string) {
  expect(body).not.toContain(LEAK_TOKEN);
  expect(body).not.toContain("REFRESH_LEAK_9999");
  expect(body).not.toContain("secretdetail-should-not-leak");
  expect(body).not.toContain("access_token");
  expect(body).not.toContain("refresh_token");
}

describe("connector token-exchange error redaction", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-connector-leak-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("PATCHWORK_HOME", patchworkHome);
    vi.stubEnv("PATCHWORK_TOKEN_DIR", tokensDir);
    vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discord callback (HTML) does not leak the raw IdP body", async () => {
    vi.stubEnv("DISCORD_CLIENT_ID", "cid");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "csecret");
    const { handleDiscordAuthorize, handleDiscordCallback } = await import(
      "../discord.js"
    );
    const state = stateFromRedirect(handleDiscordAuthorize().redirect);
    vi.stubGlobal("fetch", leakyFetch());
    const res = await handleDiscordCallback("auth-code", state, null);
    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    expect(res.body).toMatch(/400/);
  });

  it("asana callback (HTML) does not leak the raw IdP body", async () => {
    vi.stubEnv("ASANA_CLIENT_ID", "cid");
    vi.stubEnv("ASANA_CLIENT_SECRET", "csecret");
    const { handleAsanaAuthorize, handleAsanaCallback } = await import(
      "../asana.js"
    );
    const state = stateFromRedirect(handleAsanaAuthorize().redirect);
    vi.stubGlobal("fetch", leakyFetch());
    const res = await handleAsanaCallback("auth-code", state, null);
    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    expect(res.body).toMatch(/400/);
  });

  it("gitlab callback (HTML) does not leak the raw IdP body", async () => {
    vi.stubEnv("GITLAB_CLIENT_ID", "cid");
    vi.stubEnv("GITLAB_CLIENT_SECRET", "csecret");
    const { handleGitLabAuthorize, handleGitLabCallback } = await import(
      "../gitlab.js"
    );
    const state = stateFromRedirect(handleGitLabAuthorize().redirect);
    vi.stubGlobal("fetch", leakyFetch());
    const res = await handleGitLabCallback("auth-code", state, null);
    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    expect(res.body).toMatch(/400/);
  });

  it("monday callback (JSON) does not leak the raw IdP body", async () => {
    vi.stubEnv("MONDAY_CLIENT_ID", "cid");
    vi.stubEnv("MONDAY_CLIENT_SECRET", "csecret");
    const { handleMondayAuthRedirect, handleMondayCallback } = await import(
      "../monday.js"
    );
    const state = stateFromRedirect(handleMondayAuthRedirect().redirect);
    vi.stubGlobal("fetch", leakyFetch());
    const res = await handleMondayCallback("auth-code", state, null);
    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    expect(res.body).toMatch(/400/);
  });

  it("googleDocs callback (JSON) does not leak the raw IdP body", async () => {
    vi.stubEnv("GOOGLE_DOCS_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_DOCS_CLIENT_SECRET", "csecret");
    const { handleDocsAuthRedirect, handleDocsCallback } = await import(
      "../googleDocs.js"
    );
    const state = stateFromRedirect(handleDocsAuthRedirect().redirect);
    vi.stubGlobal("fetch", leakyFetch());
    const res = await handleDocsCallback("auth-code", state, null);
    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    expect(res.body).toMatch(/400/);
  });

  it("googleDrive callback (JSON) does not leak the raw IdP body", async () => {
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", "csecret");
    const { handleDriveAuthRedirect, handleDriveCallback } = await import(
      "../googleDrive.js"
    );
    const state = stateFromRedirect(handleDriveAuthRedirect().redirect);
    vi.stubGlobal("fetch", leakyFetch());
    const res = await handleDriveCallback("auth-code", state, null);
    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    expect(res.body).toMatch(/400/);
  });
});
