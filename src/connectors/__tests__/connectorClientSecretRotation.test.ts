/**
 * A rotated operator client secret reaches token refresh without a restart.
 *
 * Each of these connectors records the client secret in its token file at
 * connect time (`_client_secret`). That copy goes stale the moment the
 * operator rotates the secret, so refresh must prefer the CURRENT configured
 * value (`readSecret`: the secrets file, then env) and fall back to the
 * stored copy only when nothing is configured.
 *
 * The configured value is changed by rewriting `.secrets.json` mid-test,
 * which also proves `readSecret` reloads a changed file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsanaConnector } from "../asana.js";
import { DiscordConnector } from "../discord.js";
import { GitLabConnector } from "../gitlab.js";
import { getValidAccessToken as mondayAccessToken } from "../monday.js";
import { getValidAccessToken as salesforceAccessToken } from "../salesforce.js";
import { _resetSecretsCacheForTests } from "../secrets.js";
import { storeSecretJsonSync } from "../tokenStorage.js";

type WithGetOAuthConfig = {
  getOAuthConfig(): { clientId: string; clientSecret?: string } | null;
};

const ENV_KEYS = [
  "PATCHWORK_HOME",
  "PATCHWORK_TOKEN_STORAGE_BACKEND",
  "ASANA_CLIENT_ID",
  "ASANA_CLIENT_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "GITLAB_CLIENT_ID",
  "GITLAB_CLIENT_SECRET",
  "MONDAY_CLIENT_ID",
  "MONDAY_CLIENT_SECRET",
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
];

let tmpHome: string;

function writeSecretsFile(values: Record<string, string>): void {
  writeFileSync(join(tmpHome, ".secrets.json"), JSON.stringify(values));
}

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-secret-rotation-"));
  vi.stubEnv("PATCHWORK_HOME", tmpHome);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
  _resetSecretsCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetSecretsCacheForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe.each([
  ["asana", "ASANA", () => new AsanaConnector()],
  ["discord", "DISCORD", () => new DiscordConnector()],
  ["gitlab", "GITLAB", () => new GitLabConnector()],
] as const)("%s refresh credentials (BaseConnector)", (provider, prefix, make) => {
  function stageStored(): void {
    storeSecretJsonSync(provider, {
      access_token: "at",
      refresh_token: "rt",
      connected_at: "2026-01-01T00:00:00.000Z",
      _client_id: "stored-client-id",
      _client_secret: "connect-time-secret",
    });
  }

  function refreshSecret(): string | undefined {
    return (make() as unknown as WithGetOAuthConfig).getOAuthConfig()
      ?.clientSecret;
  }

  it("uses the rotated configured secret, picked up without a restart", () => {
    stageStored();
    writeSecretsFile({ [`${prefix}_CLIENT_SECRET`]: "first-secret" });
    expect(refreshSecret()).toBe("first-secret");
    writeSecretsFile({ [`${prefix}_CLIENT_SECRET`]: "rotated-secret" });
    expect(refreshSecret()).toBe("rotated-secret");
  });

  it("falls back to the stored copy when nothing is configured", () => {
    stageStored();
    expect(refreshSecret()).toBe("connect-time-secret");
  });
});

function okTokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "at-refreshed",
      refresh_token: "rt-2",
      expires_in: 3600,
      instance_url: "https://example.my.salesforce.com",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function sentSecret(fetchMock: ReturnType<typeof vi.fn>): string | null {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return new URLSearchParams(init.body as string).get("client_secret");
}

describe.each([
  ["monday", "MONDAY", mondayAccessToken],
  ["salesforce", "SALESFORCE", salesforceAccessToken],
] as const)("%s refresh credentials", (provider, prefix, getToken) => {
  function stageExpiring(): void {
    storeSecretJsonSync(provider, {
      access_token: "at-old",
      refresh_token: "rt",
      expiry_date: Date.now() + 1_000, // inside the 60s refresh buffer
      connected_at: "2026-01-01T00:00:00.000Z",
      instance_url: "https://example.my.salesforce.com",
      _client_id: "stored-client-id",
      _client_secret: "connect-time-secret",
    });
  }

  it("refresh sends the configured secret from the secrets file", async () => {
    stageExpiring();
    writeSecretsFile({ [`${prefix}_CLIENT_SECRET`]: "rotated-secret" });
    const fetchMock = vi.fn().mockResolvedValue(okTokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(await getToken()).toBe("at-refreshed");
    expect(sentSecret(fetchMock)).toBe("rotated-secret");
  });

  it("refresh falls back to the stored copy when nothing is configured", async () => {
    stageExpiring();
    const fetchMock = vi.fn().mockResolvedValue(okTokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    await getToken();
    expect(sentSecret(fetchMock)).toBe("connect-time-secret");
  });
});
