import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateBridgeToken } from "../bridgeToken.js";

describe("loadOrCreateBridgeToken", () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeTmpDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-token-test-"));
    return tmpDir;
  }

  it("creates a token file on first call and returns a UUID", () => {
    const configDir = makeTmpDir();
    const token = loadOrCreateBridgeToken(configDir);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const filePath = path.join(configDir, "ide", "bridge-token.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("returns the same token on subsequent calls", () => {
    const configDir = makeTmpDir();
    const token1 = loadOrCreateBridgeToken(configDir);
    const token2 = loadOrCreateBridgeToken(configDir);
    expect(token1).toBe(token2);
  });

  it("token file is written with 0o600 permissions", () => {
    const configDir = makeTmpDir();
    loadOrCreateBridgeToken(configDir);
    const filePath = path.join(configDir, "ide", "bridge-token.json");
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("token file contains valid JSON with token and createdAt fields", () => {
    const configDir = makeTmpDir();
    const token = loadOrCreateBridgeToken(configDir);
    const filePath = path.join(configDir, "ide", "bridge-token.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      token: string;
      createdAt: number;
    };
    expect(parsed.token).toBe(token);
    expect(typeof parsed.createdAt).toBe("number");
    expect(parsed.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("falls back to a fresh UUID on corrupted token file", () => {
    const configDir = makeTmpDir();
    const ideDir = path.join(configDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(path.join(ideDir, "bridge-token.json"), "not-json");
    const token = loadOrCreateBridgeToken(configDir);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("creates a .gitignore with expected entries", () => {
    const configDir = makeTmpDir();
    loadOrCreateBridgeToken(configDir);
    const gitignorePath = path.join(configDir, "ide", ".gitignore");
    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toContain("bridge-token.json");
    expect(content).toContain("oauth-tokens.json");
  });
});
