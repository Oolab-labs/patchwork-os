import { existsSync, mkdirSync, rmSync } from "node:fs";
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
