/**
 * Google token refresh keeps a rotated refresh token and forgets a revoked
 * one (Private/52 LOW).
 *
 * All four Google connectors (gmail, calendar, drive, docs) had the same two
 * defects in four copies of the same function:
 *
 *  1. A refresh response carrying a NEW `refresh_token` was ignored — the old
 *     one was saved back. Once Google retires the old token, the connector
 *     can never refresh again.
 *  2. `invalid_grant` (the user revoked access, or the token expired) threw
 *     but left the dead tokens stored. The card kept saying "connected" and
 *     every later call retried a refresh that can never succeed. The base
 *     connector already clears on this (`baseConnector.ts`); these did not.
 *
 * Real storage (file backend in a temp PATCHWORK_HOME); only `fetch` is faked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTORS = [
  { mod: "../gmail.js", key: "gmail", env: "GMAIL" },
  { mod: "../googleCalendar.js", key: "google-calendar", env: "GOOGLE" },
  { mod: "../googleDrive.js", key: "google-drive", env: "GOOGLE" },
  { mod: "../googleDocs.js", key: "google-docs", env: "GOOGLE" },
] as const;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "google-refresh-"));
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

async function seed(key: string) {
  const storage = await import("../tokenStorage.js");
  storage.storeSecretJsonSync(key, {
    access_token: "at_old",
    refresh_token: "rt_old",
    expiry_date: Date.now() - 1_000,
    _client_id: "cid",
    _client_secret: "csecret",
  });
  return storage;
}

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

describe.each(CONNECTORS)("$key token refresh", ({ mod, key }) => {
  it("saves a rotated refresh token", async () => {
    const storage = await seed(key);
    respond(200, {
      access_token: "at_new",
      refresh_token: "rt_new",
      expires_in: 3600,
    });
    const { getValidAccessToken } = await import(mod);
    expect(await getValidAccessToken()).toBe("at_new");
    expect(
      storage.getSecretJsonSync<{ refresh_token: string }>(key)?.refresh_token,
    ).toBe("rt_new");
  });

  it("keeps the existing refresh token when none is returned", async () => {
    const storage = await seed(key);
    respond(200, { access_token: "at_new", expires_in: 3600 });
    const { getValidAccessToken } = await import(mod);
    await getValidAccessToken();
    expect(
      storage.getSecretJsonSync<{ refresh_token: string }>(key)?.refresh_token,
    ).toBe("rt_old");
  });

  it("forgets the tokens when Google says invalid_grant", async () => {
    const storage = await seed(key);
    respond(400, { error: "invalid_grant" });
    const { getValidAccessToken } = await import(mod);
    await expect(getValidAccessToken()).rejects.toThrow(/invalid_grant/);
    expect(storage.getSecretJsonSync(key)).toBeNull();
  });

  it("keeps the tokens on a temporary failure", async () => {
    const storage = await seed(key);
    respond(503, { error: "backend_error" });
    const { getValidAccessToken } = await import(mod);
    await expect(getValidAccessToken()).rejects.toThrow();
    expect(storage.getSecretJsonSync(key)).not.toBeNull();
  });
});
