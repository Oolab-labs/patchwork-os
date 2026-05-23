/**
 * Tests for the file-first, env-fallback secrets reader.
 *
 * Covers the four required cases:
 *   - file present (value wins over env)
 *   - file absent, env present (fallback)
 *   - neither (returns "")
 *   - parse error (falls back silently to env)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetSecretsCacheForTests,
  readSecret,
  secretsFilePath,
} from "../secrets.js";

describe("readSecret", () => {
  let tmpHome: string;
  const envSnapshot: Record<string, string | undefined> = {};

  function setEnv(name: string, value: string | undefined): void {
    if (!(name in envSnapshot)) envSnapshot[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "patchwork-secrets-"));
    process.env.PATCHWORK_HOME = tmpHome;
    mkdirSync(tmpHome, { recursive: true });
    _resetSecretsCacheForTests();
  });

  afterEach(() => {
    delete process.env.PATCHWORK_HOME;
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(envSnapshot)) delete envSnapshot[k];
    rmSync(tmpHome, { recursive: true, force: true });
    _resetSecretsCacheForTests();
  });

  // ── file path ───────────────────────────────────────────────────────────────

  it("resolves the file path under PATCHWORK_HOME", () => {
    expect(secretsFilePath()).toBe(join(tmpHome, ".secrets.json"));
  });

  // ── file present ────────────────────────────────────────────────────────────

  it("reads a value from the secrets file when present", () => {
    writeFileSync(
      join(tmpHome, ".secrets.json"),
      JSON.stringify({ GMAIL_CLIENT_SECRET: "file-value" }),
    );
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("file-value");
  });

  it("file wins over env when both are set", () => {
    writeFileSync(
      join(tmpHome, ".secrets.json"),
      JSON.stringify({ GMAIL_CLIENT_SECRET: "from-file" }),
    );
    setEnv("GMAIL_CLIENT_SECRET", "from-env");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("from-file");
  });

  it("falls through to env when the file is missing the key", () => {
    writeFileSync(
      join(tmpHome, ".secrets.json"),
      JSON.stringify({ OTHER_SECRET: "irrelevant" }),
    );
    setEnv("GMAIL_CLIENT_SECRET", "from-env");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("from-env");
  });

  it("ignores non-string values in the secrets file", () => {
    writeFileSync(
      join(tmpHome, ".secrets.json"),
      JSON.stringify({ GMAIL_CLIENT_SECRET: 42 }),
    );
    setEnv("GMAIL_CLIENT_SECRET", "from-env");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("from-env");
  });

  it("treats an empty-string file value as unset (falls back to env)", () => {
    writeFileSync(
      join(tmpHome, ".secrets.json"),
      JSON.stringify({ GMAIL_CLIENT_SECRET: "" }),
    );
    setEnv("GMAIL_CLIENT_SECRET", "from-env");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("from-env");
  });

  // ── file absent ─────────────────────────────────────────────────────────────

  it("reads from env when the secrets file is absent", () => {
    setEnv("GMAIL_CLIENT_SECRET", "env-only");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("env-only");
  });

  it("returns empty string when neither file nor env is set", () => {
    setEnv("GMAIL_CLIENT_SECRET", undefined);
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("");
  });

  // ── error tolerance ─────────────────────────────────────────────────────────

  it("falls back to env when the file is malformed JSON", () => {
    writeFileSync(join(tmpHome, ".secrets.json"), "{not json");
    setEnv("GMAIL_CLIENT_SECRET", "from-env");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("from-env");
  });

  it("falls back to env when the file is JSON but not an object", () => {
    writeFileSync(join(tmpHome, ".secrets.json"), JSON.stringify(["array"]));
    setEnv("GMAIL_CLIENT_SECRET", "from-env");
    expect(readSecret("GMAIL_CLIENT_SECRET")).toBe("from-env");
  });

  // ── memoization ─────────────────────────────────────────────────────────────

  it("memoizes the file read across calls", () => {
    writeFileSync(join(tmpHome, ".secrets.json"), JSON.stringify({ A: "one" }));
    expect(readSecret("A")).toBe("one");

    // Rewrite the file after the first read. Without resetting the cache, the
    // helper continues serving the old value — that is the documented contract.
    writeFileSync(join(tmpHome, ".secrets.json"), JSON.stringify({ A: "two" }));
    expect(readSecret("A")).toBe("one");

    // After the explicit reset hook, the next read picks up the new value.
    _resetSecretsCacheForTests();
    expect(readSecret("A")).toBe("two");
  });
});
