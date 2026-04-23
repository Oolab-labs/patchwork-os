import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("jira token storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-jira-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_INSTANCE_URL;
    delete process.env.JIRA_EMAIL;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns env-var tokens without reading secure storage", async () => {
    process.env.JIRA_API_TOKEN = "jira-token";
    process.env.JIRA_INSTANCE_URL = "https://acme.atlassian.net/";
    process.env.JIRA_EMAIL = "dev@acme.test";

    const { loadTokens } = await import("../jira.js");

    expect(loadTokens()).toEqual(
      expect.objectContaining({
        accessToken: "jira-token",
        instanceUrl: "https://acme.atlassian.net",
        isCloud: true,
        email: "dev@acme.test",
      }),
    );
  });

  it("migrates a legacy jira token file into secure storage on read", async () => {
    const legacyTokens = {
      accessToken: "legacy-token",
      email: "ops@acme.test",
      instanceUrl: "https://jira.acme.test",
      isCloud: false,
      connected_at: "2026-04-23T00:00:00.000Z",
    };

    writeFileSync(
      join(tokensDir, "jira.json"),
      JSON.stringify(legacyTokens, null, 2),
    );

    const { loadTokens } = await import("../jira.js");

    expect(loadTokens()).toEqual(legacyTokens);
    expect(existsSync(join(tokensDir, "jira.json"))).toBe(false);
    expect(existsSync(join(tokensDir, "patchwork-os.jira.enc"))).toBe(true);
  });

  it("saves jira tokens through the shared secure storage helper", async () => {
    const tokens = {
      accessToken: "secure-token",
      email: "eng@acme.test",
      instanceUrl: "https://acme.atlassian.net",
      isCloud: true,
      connected_at: "2026-04-23T00:00:00.000Z",
    };

    const { loadTokens, saveTokens } = await import("../jira.js");

    saveTokens(tokens);

    expect(loadTokens()).toEqual(tokens);
    expect(existsSync(join(tokensDir, "patchwork-os.jira.enc"))).toBe(true);
  });
});
