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
  __setKeychainOpsForTest,
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

describe("tokenStorage auto-backend fallback eviction (audit 2026-06-03 HIGH #10)", () => {
  // NB: this is the AUTO path (keychain with encrypted-file fallback). The
  // keychain-only `native` backend (MEDIUM #21) deliberately does NOT fall
  // back to file, so the fallback-eviction behavior tested here lives in auto.
  const tmpDir = join(os.tmpdir(), `patchwork-test-tokens-kc-${Date.now()}`);

  beforeEach(() => {
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "auto";
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    __setKeychainOpsForTest(null);
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("evicts the stale keychain entry when a later write falls back to file", async () => {
    const kc = new Map<string, string>();
    let keychainWritable = true;
    __setKeychainOpsForTest({
      set: (k, v) => {
        if (!keychainWritable) return false;
        kc.set(k, v);
        return true;
      },
      get: (k) => (kc.has(k) ? (kc.get(k) as string) : null),
      delete: (k) => kc.delete(k),
    });

    // 1) First write succeeds → lands in the (fake) keychain.
    await storeTokens("kc-provider", { accessToken: "STALE-TOKEN" });
    expect((await getTokens("kc-provider"))?.accessToken).toBe("STALE-TOKEN");

    // 2) Keychain writes now fail (e.g. locked keychain). The fresh token must
    //    fall back to the encrypted file AND the stale keychain entry must be
    //    evicted — otherwise getTokens (keychain-first) returns the old token.
    keychainWritable = false;
    await storeTokens("kc-provider", { accessToken: "FRESH-TOKEN" });

    expect((await getTokens("kc-provider"))?.accessToken).toBe("FRESH-TOKEN");
  });
});

describe("tokenStorage native backend = keychain-only (audit 2026-06-03 MEDIUM #21)", () => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-test-tokens-native-${Date.now()}`,
  );

  beforeEach(() => {
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "native";
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    __setKeychainOpsForTest(null);
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("stores and reads via the keychain only (no file written)", async () => {
    const kc = new Map<string, string>();
    __setKeychainOpsForTest({
      set: (k, v) => {
        kc.set(k, v);
        return true;
      },
      get: (k) => (kc.has(k) ? (kc.get(k) as string) : null),
      delete: (k) => kc.delete(k),
    });
    await storeTokens("native-provider", { accessToken: "KC-ONLY" });
    expect((await getTokens("native-provider"))?.accessToken).toBe("KC-ONLY");
    // The credential lives in the (fake) keychain, not on disk.
    expect(kc.size).toBe(1);
  });

  it("THROWS instead of silently writing a file when the keychain is unavailable", async () => {
    __setKeychainOpsForTest({
      set: () => false, // keychain write fails
      get: () => null,
      delete: () => false,
    });
    await expect(
      storeTokens("native-provider", { accessToken: "x" }),
    ).rejects.toThrow(/native.*keychain|refusing to fall back/i);
  });

  it("does NOT fall back to reading a stale file (keychain-only read)", async () => {
    // Pre-seed an encrypted file under file-backend, then switch to native.
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    await storeTokens("native-provider", { accessToken: "STALE-FILE" });
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "native";
    __setKeychainOpsForTest({
      set: () => true,
      get: () => null, // keychain empty
      delete: () => true,
    });
    // native read must return null (keychain empty) — never the stale file.
    expect(await getTokens("native-provider")).toBeNull();
  });
});

// LOW #10 — listMacOSKeychainItems uses `security dump-keychain` which reads
// every keychain entry. Fix: use the per-key `find-generic-password` approach
// (O(1) per provider, doesn't expose unrelated secrets). The injectable
// KeychainOpsForTest.list hook lets tests verify the list path uses the override
// rather than running the real `security` CLI.
describe("listStoredProviders uses keychain list override, not dump-keychain (audit 2026-06-03 LOW #10)", () => {
  const tmpDir = join(
    os.tmpdir(),
    `patchwork-test-tokens-kc-list-${Date.now()}`,
  );

  beforeEach(() => {
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "auto";
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    __setKeychainOpsForTest(null);
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("uses the injected list() hook when listing providers", async () => {
    const kc = new Map<string, string>();
    let listCallCount = 0;

    // Keys stored in kc use the full storageKey form "patchwork-os.<provider>".
    // The list() hook must return provider names (with the prefix stripped),
    // matching the contract of listKeychainItems() / listStoredProviders().
    const SERVICE_PREFIX = "patchwork-os.";
    __setKeychainOpsForTest({
      set: (k, v) => {
        kc.set(k, v);
        return true;
      },
      get: (k) => kc.get(k) ?? null,
      delete: (k) => kc.delete(k),
      list: () => {
        listCallCount++;
        return [...kc.keys()]
          .filter((k) => k.startsWith(SERVICE_PREFIX))
          .map((k) => k.slice(SERVICE_PREFIX.length));
      },
    });

    await storeTokens("provider-x", { accessToken: "token-x" });
    await storeTokens("provider-y", { accessToken: "token-y" });

    const providers = await listStoredProviders();
    // The list override must have been consulted.
    expect(listCallCount).toBeGreaterThan(0);
    expect(providers).toContain("provider-x");
    expect(providers).toContain("provider-y");
  });
});
