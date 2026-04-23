import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateBridgeToken } from "../bridgeToken.js";

describe("loadOrCreateBridgeToken", () => {
  let tmpDir: string;

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeTmpDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-token-test-"));
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    return tmpDir;
  }

  function tokenStoreFilePath(configDir: string): string {
    const digest = createHash("sha256")
      .update(path.resolve(configDir))
      .digest("hex")
      .slice(0, 24);
    return path.join(
      tmpDir,
      "tokens",
      `patchwork-os.bridge-token-${digest}.enc`,
    );
  }

  it("creates a secure token entry on first call and returns a UUID", () => {
    const configDir = makeTmpDir();
    const token = loadOrCreateBridgeToken(configDir);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(tokenStoreFilePath(configDir))).toBe(true);
  });

  it("returns the same token on subsequent calls", () => {
    const configDir = makeTmpDir();
    const token1 = loadOrCreateBridgeToken(configDir);
    const token2 = loadOrCreateBridgeToken(configDir);
    expect(token1).toBe(token2);
  });

  it("token snapshot is persisted through file-backed secure storage with 0o600 permissions", () => {
    const configDir = makeTmpDir();
    loadOrCreateBridgeToken(configDir);
    const filePath = tokenStoreFilePath(configDir);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("migrates a legacy bridge-token.json file into secure storage", () => {
    const configDir = makeTmpDir();
    const ideDir = path.join(configDir, "ide");
    const legacyPath = path.join(ideDir, "bridge-token.json");
    const legacyToken = "123e4567-e89b-12d3-a456-426614174000";
    const createdAt = Date.now() - 1_000;
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ token: legacyToken, createdAt }),
      {
        mode: 0o600,
      },
    );

    const token = loadOrCreateBridgeToken(configDir);

    expect(token).toBe(legacyToken);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(tokenStoreFilePath(configDir))).toBe(true);
  });

  it("falls back to a fresh UUID when the legacy token file is corrupted", () => {
    const configDir = makeTmpDir();
    const ideDir = path.join(configDir, "ide");
    const legacyPath = path.join(ideDir, "bridge-token.json");
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(legacyPath, "not-json");

    const token = loadOrCreateBridgeToken(configDir);

    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(tokenStoreFilePath(configDir))).toBe(true);
  });

  it("creates a .gitignore with expected entries", () => {
    const configDir = makeTmpDir();
    loadOrCreateBridgeToken(configDir);
    const gitignorePath = path.join(configDir, "ide", ".gitignore");
    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toContain("bridge-token.json");
    expect(content).toContain("oauth-tokens.json");
  });

  it("keeps bridge tokens scoped by configDir", () => {
    const baseDir = makeTmpDir();
    const configDirA = path.join(baseDir, "config-a");
    const configDirB = path.join(baseDir, "config-b");

    const tokenA = loadOrCreateBridgeToken(configDirA);
    const tokenB = loadOrCreateBridgeToken(configDirB);

    expect(tokenA).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenB).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(tokenStoreFilePath(configDirA))).toBe(true);
    expect(fs.existsSync(tokenStoreFilePath(configDirB))).toBe(true);
    expect(loadOrCreateBridgeToken(configDirA)).toBe(tokenA);
    expect(loadOrCreateBridgeToken(configDirB)).toBe(tokenB);
  });
});
