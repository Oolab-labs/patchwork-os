import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-cfg-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function importFresh() {
  vi.resetModules();
  return await import("../analyticsConfig.js");
}

describe("analyticsConfig", () => {
  it("returns empty config when file is missing", async () => {
    const { getAnalyticsConfig } = await importFresh();
    expect(getAnalyticsConfig()).toEqual({});
  });

  it("round-trips endpoint + key", async () => {
    const { setAnalyticsConfig, getAnalyticsConfig, configPath } =
      await importFresh();
    setAnalyticsConfig({
      endpoint: "https://collector.example.com/v1/usage",
      key: "abc123",
    });
    expect(getAnalyticsConfig()).toEqual({
      endpoint: "https://collector.example.com/v1/usage",
      key: "abc123",
    });
    const stat = fs.statSync(configPath());
    // POSIX file modes don't apply on Windows (NTFS reports 0o666 for any
    // writable file regardless of the mode passed to writeFileSync). Skip
    // the perms assertion there; the 0o600 still takes effect on macOS/Linux.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("rejects an invalid endpoint URL", async () => {
    const { setAnalyticsConfig } = await importFresh();
    expect(() => setAnalyticsConfig({ endpoint: "not a url" })).toThrow(
      /invalid endpoint/,
    );
  });

  it("rejects a non-http(s) scheme", async () => {
    const { setAnalyticsConfig } = await importFresh();
    expect(() =>
      setAnalyticsConfig({ endpoint: "file:///etc/passwd" }),
    ).toThrow(/invalid endpoint/);
  });

  it("ignores invalid endpoints already on disk (read-side guard)", async () => {
    const { configPath, getAnalyticsConfig } = await importFresh();
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ endpoint: "ftp://nope", key: "k" }),
    );
    expect(getAnalyticsConfig()).toEqual({ key: "k" });
  });

  it("merges updates rather than overwriting unspecified fields", async () => {
    const { setAnalyticsConfig, getAnalyticsConfig } = await importFresh();
    setAnalyticsConfig({
      endpoint: "https://a.example.com/u",
      key: "k1",
    });
    setAnalyticsConfig({ key: "k2" });
    expect(getAnalyticsConfig()).toEqual({
      endpoint: "https://a.example.com/u",
      key: "k2",
    });
  });

  it("clears a field when passed undefined explicitly", async () => {
    const { setAnalyticsConfig, getAnalyticsConfig } = await importFresh();
    setAnalyticsConfig({
      endpoint: "https://a.example.com/u",
      key: "k1",
    });
    setAnalyticsConfig({ key: undefined });
    expect(getAnalyticsConfig()).toEqual({
      endpoint: "https://a.example.com/u",
    });
  });

  it("clearAnalyticsConfig removes the file", async () => {
    const { setAnalyticsConfig, clearAnalyticsConfig, configPath } =
      await importFresh();
    setAnalyticsConfig({ endpoint: "https://a.example.com/u" });
    expect(fs.existsSync(configPath())).toBe(true);
    clearAnalyticsConfig();
    expect(fs.existsSync(configPath())).toBe(false);
    // idempotent
    expect(() => clearAnalyticsConfig()).not.toThrow();
  });
});
