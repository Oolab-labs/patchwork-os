/**
 * Contract lock for Discord's OAuth config wiring.
 *
 * Discord is one of the three BaseConnector subclasses with a real
 * `tokenEndpoint`. See asanaOAuthConfig.test.ts for the rationale.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiscordConnector } from "../discord.js";

type WithGetOAuthConfig = {
  getOAuthConfig(): {
    clientId: string;
    tokenEndpoint: string;
    scopes?: string[];
  } | null;
};

const DISCORD_CANONICAL_TOKEN_URL = "https://discord.com/api/oauth2/token";

describe("DiscordConnector.getOAuthConfig()", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "patchwork-discord-oauth-"));
    process.env.PATCHWORK_HOME = tmpHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null when neither env nor stored credentials are present", () => {
    const config = (
      new DiscordConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();
    expect(config).toBeNull();
  });

  it("returns canonical token URL + scopes when env credentials are present", () => {
    process.env.DISCORD_CLIENT_ID = "test_client_id";
    process.env.DISCORD_CLIENT_SECRET = "test_client_secret";

    const config = (
      new DiscordConnector() as unknown as WithGetOAuthConfig
    ).getOAuthConfig();

    expect(config).not.toBeNull();
    expect(config?.tokenEndpoint).toBe(DISCORD_CANONICAL_TOKEN_URL);
    expect(config?.scopes).toEqual(["identify", "guilds", "messages.read"]);
    expect(config?.clientId).toBe("test_client_id");
  });
});
