import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteTokens,
  getTokens,
  listStoredProviders,
  type StoredToken,
  storeTokens,
} from "../tokenStorage.js";

describe("tokenStorage", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-test-tokens-${Date.now()}`);

  beforeEach(() => {
    // Set a custom storage location for testing via env
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("stores and retrieves tokens", async () => {
    const tokens: StoredToken = {
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAt: new Date().toISOString(),
      scopes: ["read", "write"],
    };

    await storeTokens("test-provider", tokens);
    const retrieved = await getTokens("test-provider");

    expect(retrieved).toEqual(tokens);
  });

  it("returns null for unknown provider", async () => {
    const retrieved = await getTokens("nonexistent-provider");
    expect(retrieved).toBeNull();
  });

  it("deletes tokens", async () => {
    const tokens: StoredToken = {
      accessToken: "to-delete",
    };

    await storeTokens("delete-me", tokens);
    expect(await getTokens("delete-me")).toEqual(tokens);

    await deleteTokens("delete-me");
    expect(await getTokens("delete-me")).toBeNull();
  });

  it("lists stored providers", async () => {
    await storeTokens("provider-a", { accessToken: "a" });
    await storeTokens("provider-b", { accessToken: "b" });

    const providers = await listStoredProviders();
    expect(providers).toContain("provider-a");
    expect(providers).toContain("provider-b");
  });

  it("uses a random master key, not hostname-derived", async () => {
    await storeTokens("key-check", { accessToken: "x" });
    const keyFile = join(tmpDir, "tokens", ".master.key");
    expect(existsSync(keyFile)).toBe(true);
    const keyBytes = readFileSync(keyFile);
    expect(keyBytes.length).toBe(32);
    const legacy = crypto
      .createHash("sha256")
      .update(`${os.hostname()}-${os.userInfo().username}`)
      .digest()
      .slice(0, 32);
    expect(keyBytes.equals(legacy)).toBe(false);
  });

  it("migrates files encrypted with the legacy hostname-derived key", async () => {
    // Simulate a file written by the pre-fix version: encrypted with legacy key,
    // no master.key present yet.
    const legacyKey = crypto
      .createHash("sha256")
      .update(`${os.hostname()}-${os.userInfo().username}`)
      .digest()
      .slice(0, 32);
    const payload = JSON.stringify({ accessToken: "legacy-token" });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    let enc = cipher.update(payload, "utf8", "hex");
    enc += cipher.final("hex");
    const authTag = cipher.getAuthTag();
    const blob = `${iv.toString("hex")}:${authTag.toString("hex")}:${enc}`;

    const tokensDir = join(tmpDir, "tokens");
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, "patchwork-os.legacy-provider.enc"), blob);

    const retrieved = await getTokens("legacy-provider");
    expect(retrieved?.accessToken).toBe("legacy-token");

    // After read, master.key exists and file is now decryptable with it.
    expect(existsSync(join(tokensDir, ".master.key"))).toBe(true);
    const again = await getTokens("legacy-provider");
    expect(again?.accessToken).toBe("legacy-token");
  });

  it("handles tokens without refresh token", async () => {
    const tokens: StoredToken = {
      accessToken: "no-refresh",
    };

    await storeTokens("no-refresh-provider", tokens);
    const retrieved = await getTokens("no-refresh-provider");

    expect(retrieved?.accessToken).toBe("no-refresh");
    expect(retrieved?.refreshToken).toBeUndefined();
  });
});
