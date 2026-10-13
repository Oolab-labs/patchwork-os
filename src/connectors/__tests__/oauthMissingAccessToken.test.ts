/**
 * A token endpoint that answers 200 without an `access_token` must not be
 * read as a success. These connectors used to save whatever the body held,
 * so a connect stored a record with no token and a refresh overwrote a
 * working token with `undefined`. Both paths now refuse with
 * "Token exchange returned no access_token" / "Token refresh returned no
 * access_token", and nothing is saved.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Case {
  name: string;
  module: string;
  envPrefix: string;
  file: string;
  redirect: string;
  callback: string;
}

const CASES: Case[] = [
  {
    name: "gmail",
    module: "../gmail.js",
    envPrefix: "GMAIL",
    file: "gmail.json",
    redirect: "handleGmailAuthRedirect",
    callback: "handleGmailCallback",
  },
  {
    name: "googleDrive",
    module: "../googleDrive.js",
    envPrefix: "GOOGLE_DRIVE",
    file: "google-drive.json",
    redirect: "handleDriveAuthRedirect",
    callback: "handleDriveCallback",
  },
  {
    name: "googleCalendar",
    module: "../googleCalendar.js",
    envPrefix: "GOOGLE_CALENDAR",
    file: "google-calendar.json",
    redirect: "handleCalendarAuthRedirect",
    callback: "handleCalendarCallback",
  },
  {
    name: "googleDocs",
    module: "../googleDocs.js",
    envPrefix: "GOOGLE_DOCS",
    file: "google-docs.json",
    redirect: "handleDocsAuthRedirect",
    callback: "handleDocsCallback",
  },
  {
    name: "monday",
    module: "../monday.js",
    envPrefix: "MONDAY",
    file: "monday.json",
    redirect: "handleMondayAuthRedirect",
    callback: "handleMondayCallback",
  },
];

type Mod = Record<string, unknown> & {
  loadTokens: () => { access_token?: string } | null;
  getValidAccessToken: () => Promise<string>;
};

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  } as unknown as Response;
}

describe.each(CASES)("$name: 200 without access_token", (c) => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-missing-at-${c.name}-${process.pid}-${Date.now()}`,
  );
  const tokenDir = join(tmpDir, "tokens");

  beforeEach(() => {
    mkdirSync(tokenDir, { recursive: true });
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_DIR = tokenDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    process.env[`${c.envPrefix}_CLIENT_ID`] = "test-client-id";
    process.env[`${c.envPrefix}_CLIENT_SECRET`] = "test-client-secret";
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_DIR;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env[`${c.envPrefix}_CLIENT_ID`];
    delete process.env[`${c.envPrefix}_CLIENT_SECRET`];
    vi.unstubAllGlobals();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connect: refuses and saves nothing", async () => {
    const mod = (await import(c.module)) as Mod;
    const redirect = (mod[c.redirect] as () => { redirect?: string })();
    const state = new URL(redirect.redirect ?? "").searchParams.get("state");
    expect(state).toBeTruthy();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ token_type: "Bearer" })),
    );
    const result = await (
      mod[c.callback] as (
        code: string,
        state: string | null,
        error: null,
      ) => Promise<{ status: number; body: string }>
    )("auth-code", state, null);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toContain("Token exchange returned no access_token");
    expect(mod.loadTokens()).toBeNull();
  });

  it("refresh: refuses and keeps the stored token", async () => {
    writeFileSync(
      join(tokenDir, c.file),
      JSON.stringify({
        access_token: "at_old",
        refresh_token: "rt_old",
        expiry_date: Date.now() - 60_000,
      }),
    );
    const mod = (await import(c.module)) as Mod;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ expires_in: 3600 })),
    );
    await expect(mod.getValidAccessToken()).rejects.toThrow(
      "Token refresh returned no access_token",
    );
    expect(mod.loadTokens()?.access_token).toBe("at_old");
  });
});
