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

    const result = await handleSlackDisconnect();

    expect(result.status).toBe(200);
    expect(existsSync(join(tokensDir, "slack-state.json"))).toBe(false);
  });

  // ─── auth.revoke upstream (audit 2026-05-17) ────────────────────────────
  // Pre-fix, disconnect was local-only — a leaked token kept working.
  // Now the bot token is revoked at Slack before the local delete.
  it("posts to auth.revoke before deleting tokens, with the bearer", async () => {
    // Plant a real token-file so loadTokens returns access_token.
    const { storeSecretJsonSync } = await import("../tokenStorage.js");
    storeSecretJsonSync("slack", {
      access_token: "xoxb-test-token-abc",
      bot_user_id: "U0",
      team_id: "T0",
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const { handleSlackDisconnect } = await import("../slack.js");
    const result = await handleSlackDisconnect();

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://slack.com/api/auth.revoke");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer xoxb-test-token-abc");
  });

  it("still deletes local tokens when auth.revoke fails (best-effort)", async () => {
    const { storeSecretJsonSync } = await import("../tokenStorage.js");
    storeSecretJsonSync("slack", {
      access_token: "xoxb-test-token-fail",
      bot_user_id: "U0",
      team_id: "T0",
    });

    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const { handleSlackDisconnect, isConnected } = await import("../slack.js");
    const result = await handleSlackDisconnect();

    expect(result.status).toBe(200);
    // Local delete must still happen — disconnect should never leave
    // the user "stuck connected" because the vendor was unreachable.
    expect(isConnected()).toBe(false);
  });

  it("skips auth.revoke when there is no stored token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    vi.resetModules();
    const { handleSlackDisconnect } = await import("../slack.js");
    const result = await handleSlackDisconnect();

    expect(result.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
