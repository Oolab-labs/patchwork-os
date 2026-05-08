/**
 * Regression tests for the apiKeys → secure store migration.
 *
 * Before the migration, provider API keys were persisted plaintext in
 * ~/.patchwork/config.json (mode 0600). They now live in the secure token
 * store (Keychain/DPAPI/Secret Service / AES-256-GCM file fallback) and
 * never round-trip back to plaintext on disk.
 *
 * These tests pin three guarantees:
 *   - One-time migration: an existing plaintext config is rewritten
 *     without `apiKeys` and the keys land in the secure store.
 *   - saveConfig strips apiKeys before writing — defense in depth.
 *   - saveApiKeyToSecureStore round-trips and deletes on empty string.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getApiKeysPresent,
  loadConfig,
  saveApiKeyToSecureStore,
  saveConfig,
} from "../patchworkConfig.js";

let tempHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "pw-cfg-test-"));
  prevHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = tempHome;
  // Force file backend so tests don't depend on (or pollute) the host
  // Keychain / DPAPI / Secret Service.
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("apiKeys migration on load", () => {
  it("removes plaintext apiKeys from disk and stores them securely", () => {
    const cfgPath = join(tempHome, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        model: "claude",
        apiKeys: {
          anthropic: "sk-ant-test-anthropic-key",
          openai: "sk-test-openai-key",
        },
      }),
    );

    const loaded = loadConfig(cfgPath);

    // In-memory cfg still surfaces the keys (callers / adapters keep working)
    expect(loaded.apiKeys?.anthropic).toBe("sk-ant-test-anthropic-key");
    expect(loaded.apiKeys?.openai).toBe("sk-test-openai-key");

    // Disk file no longer carries them
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.apiKeys).toBeUndefined();

    // Reloading still produces the keys — they're now sourced from the store
    const reloaded = loadConfig(cfgPath);
    expect(reloaded.apiKeys?.anthropic).toBe("sk-ant-test-anthropic-key");
    expect(reloaded.apiKeys?.openai).toBe("sk-test-openai-key");
  });

  it("loads keys from the secure store when no config file exists", () => {
    saveApiKeyToSecureStore("anthropic", "sk-ant-fresh-key");
    const loaded = loadConfig(join(tempHome, "missing.json"));
    expect(loaded.apiKeys?.anthropic).toBe("sk-ant-fresh-key");
  });

  it("leaves a clean config file untouched on load", () => {
    const cfgPath = join(tempHome, "config.json");
    const original = { model: "claude", defaultModel: "claude-opus-4-7" };
    writeFileSync(cfgPath, JSON.stringify(original));

    loadConfig(cfgPath);

    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(onDisk).toEqual(original);
  });
});

describe("saveConfig strips apiKeys", () => {
  it("never writes apiKeys to disk even when caller sets them in-memory", () => {
    const cfgPath = join(tempHome, "config.json");
    saveConfig(
      {
        model: "claude",
        apiKeys: { anthropic: "should-not-leak-to-disk" },
      },
      cfgPath,
    );

    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.apiKeys).toBeUndefined();
    expect(onDisk.model).toBe("claude");
  });
});

describe("saveApiKeyToSecureStore", () => {
  it("round-trips a key through the secure store", () => {
    saveApiKeyToSecureStore("openai", "sk-roundtrip");
    const loaded = loadConfig(join(tempHome, "missing.json"));
    expect(loaded.apiKeys?.openai).toBe("sk-roundtrip");
  });

  it("deletes the entry when called with empty string", () => {
    saveApiKeyToSecureStore("xai", "sk-xai-temp");
    expect(loadConfig(join(tempHome, "missing.json")).apiKeys?.xai).toBe(
      "sk-xai-temp",
    );

    saveApiKeyToSecureStore("xai", "");
    expect(
      loadConfig(join(tempHome, "missing.json")).apiKeys?.xai,
    ).toBeUndefined();
  });

  it("does not write the secret to a plaintext file in PATCHWORK_HOME", () => {
    saveApiKeyToSecureStore("google", "secret-google-key-xyz");
    // The encrypted .enc file under tokens/ may exist (file backend) but
    // its contents must not contain the cleartext key.
    const tokenDir = join(tempHome, "tokens");
    if (!existsSync(tokenDir)) return;
    // Walk the dir; any file's bytes must not contain the cleartext.
    for (const name of readdirSync(tokenDir)) {
      const buf = readFileSync(join(tokenDir, name), "utf-8");
      expect(buf).not.toContain("secret-google-key-xyz");
    }
  });
});

describe("getApiKeysPresent", () => {
  // Used by /status to surface which providers have a key without ever
  // exposing the key itself to the dashboard. Must return a boolean for all
  // four providers regardless of which (or none) are stored.

  it("returns false for every provider when the store is empty", () => {
    const present = getApiKeysPresent();
    expect(present).toEqual({
      anthropic: false,
      openai: false,
      google: false,
      xai: false,
    });
  });

  it("flips a provider to true when its key is saved", () => {
    saveApiKeyToSecureStore("openai", "sk-present-test");
    const present = getApiKeysPresent();
    expect(present.openai).toBe(true);
    // Other providers stay false
    expect(present.anthropic).toBe(false);
    expect(present.google).toBe(false);
    expect(present.xai).toBe(false);
  });

  it("flips back to false after the key is cleared", () => {
    saveApiKeyToSecureStore("xai", "xai-key-temp");
    expect(getApiKeysPresent().xai).toBe(true);

    saveApiKeyToSecureStore("xai", "");
    expect(getApiKeysPresent().xai).toBe(false);
  });

  it("never includes the actual key in the return value", () => {
    const secret = "anthropic-key-do-not-leak-zzz";
    saveApiKeyToSecureStore("anthropic", secret);
    const present = getApiKeysPresent();
    // Stringify and grep — the secret must not appear anywhere in the value.
    expect(JSON.stringify(present)).not.toContain(secret);
  });
});
