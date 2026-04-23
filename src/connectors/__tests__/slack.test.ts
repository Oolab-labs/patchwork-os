import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("slack token storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-slack-${Date.now()}`);
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
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("migrates a legacy slack token file into secure storage on read", async () => {
    const legacyTokens = {
      access_token: "xoxb-legacy",
      team_id: "T123",
      team_name: "Acme",
      bot_user_id: "U123",
      connected_at: "2026-04-23T00:00:00.000Z",
    };

    writeFileSync(
      join(tokensDir, "slack.json"),
      JSON.stringify(legacyTokens, null, 2),
    );

    const { loadTokens } = await import("../slack.js");

    expect(loadTokens()).toEqual(legacyTokens);
    expect(existsSync(join(tokensDir, "slack.json"))).toBe(false);
    expect(existsSync(join(tokensDir, "patchwork-os.slack.enc"))).toBe(true);
  });

  it("reports connected after saving tokens through the callback path", async () => {
    const state = "test-state";
    writeFileSync(
      join(tokensDir, "slack-state.json"),
      JSON.stringify({ state, ts: Date.now() }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          access_token: "xoxb-new",
          bot_user_id: "U999",
          team: { id: "T999", name: "New Team" },
        }),
      } as unknown as Response),
    );

    process.env.PATCHWORK_SLACK_CLIENT_ID = "slack-client";
    process.env.PATCHWORK_SLACK_CLIENT_SECRET = "slack-secret";

    const { handleSlackCallback, isConnected, getProfile } = await import(
      "../slack.js"
    );

    const result = await handleSlackCallback("code-123", state, null);

    expect(result.status).toBe(200);
    expect(isConnected()).toBe(true);
    expect(getProfile()).toEqual({
      teamId: "T999",
      teamName: "New Team",
      botUserId: "U999",
    });
    expect(existsSync(join(tokensDir, "patchwork-os.slack.enc"))).toBe(true);
    expect(existsSync(join(tokensDir, "slack-state.json"))).toBe(false);
  });

  it("deletes secure tokens and leftover state on disconnect", async () => {
    writeFileSync(join(tokensDir, "patchwork-os.slack.enc"), "00:00:00");
    writeFileSync(
      join(tokensDir, "slack-state.json"),
      JSON.stringify({ state: "leftover", ts: Date.now() }),
    );

    const { handleSlackDisconnect } = await import("../slack.js");

    const result = handleSlackDisconnect();

    expect(result.status).toBe(200);
    expect(existsSync(join(tokensDir, "slack-state.json"))).toBe(false);
  });
});
