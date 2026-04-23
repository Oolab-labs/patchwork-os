import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTokenFile,
  type McpTokenFile,
  updateTokenProfile,
} from "../mcpOAuth.js";

describe("mcpOAuth storage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-mcp-oauth-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("migrates a legacy MCP token file into secure storage on read", () => {
    const legacyToken: McpTokenFile = {
      vendor: "github",
      client_id: "client-id",
      access_token: "access-token",
      connected_at: "2026-04-23T00:00:00.000Z",
      profile: { login: "wesh" },
    };
    const legacyPath = join(tokensDir, "github-mcp.json");

    writeFileSync(legacyPath, JSON.stringify(legacyToken, null, 2));

    const loaded = loadTokenFile("github");

    expect(loaded).toEqual(legacyToken);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(tokensDir, "patchwork-os.github-mcp.enc"))).toBe(
      true,
    );
  });

  it("persists merged profile metadata through the shared update helper", () => {
    const legacyToken: McpTokenFile = {
      vendor: "linear",
      client_id: "linear-client",
      access_token: "linear-token",
      connected_at: "2026-04-23T00:00:00.000Z",
      profile: { org: "acme" },
    };

    writeFileSync(
      join(tokensDir, "linear-mcp.json"),
      JSON.stringify(legacyToken, null, 2),
    );

    expect(loadTokenFile("linear")).toEqual(legacyToken);

    updateTokenProfile("linear", { workspace: "acme-workspace" });

    expect(loadTokenFile("linear")).toEqual({
      ...legacyToken,
      profile: {
        org: "acme",
        workspace: "acme-workspace",
      },
    });
  });
});
