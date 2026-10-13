/**
 * Tests for the file-first, env-fallback secrets reader.
 *
 * Covers the four required cases:
 *   - file present (value wins over env)
 *   - file absent, env present (fallback)
 *   - neither (returns "")
 *   - parse error (falls back silently to env)
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

  // ── reload ──────────────────────────────────────────────────────────────────

  it("picks up a rewritten file on the next call without a reset", () => {
    const f = join(tmpHome, ".secrets.json");
    writeFileSync(f, JSON.stringify({ A: "one" }));
    expect(readSecret("A")).toBe("one");

    writeFileSync(f, JSON.stringify({ A: "rotated-value" }));
    expect(readSecret("A")).toBe("rotated-value");
  });

  it("picks up a file created after a first read found none", () => {
    setEnv("A", "from-env");
    expect(readSecret("A")).toBe("from-env");
    writeFileSync(
      join(tmpHome, ".secrets.json"),
      JSON.stringify({ A: "file" }),
    );
    expect(readSecret("A")).toBe("file");
  });

  it("a half-written file does not poison later reads", () => {
    const f = join(tmpHome, ".secrets.json");
    setEnv("A", "from-env");
    writeFileSync(f, JSON.stringify({ A: "good" }));
    expect(readSecret("A")).toBe("good");

    // Mid-write: truncated JSON. Keep serving the last good value.
    writeFileSync(f, '{"A": "new');
    expect(readSecret("A")).toBe("good");
    // Empty (truncate-then-write) is also a partial state.
    writeFileSync(f, "");
    expect(readSecret("A")).toBe("good");

    // Write completes: the new value is served.
    writeFileSync(f, JSON.stringify({ A: "new-value" }));
    expect(readSecret("A")).toBe("new-value");
  });

  it("a parse failure on first load is retried, not cached", () => {
    const f = join(tmpHome, ".secrets.json");
    setEnv("A", "from-env");
    writeFileSync(f, "{partial");
    expect(readSecret("A")).toBe("from-env");
    writeFileSync(f, JSON.stringify({ A: "complete" }));
    expect(readSecret("A")).toBe("complete");
  });

  it("deleting the file returns to env", () => {
    const f = join(tmpHome, ".secrets.json");
    setEnv("A", "from-env");
    writeFileSync(f, JSON.stringify({ A: "file" }));
    expect(readSecret("A")).toBe("file");
    unlinkSync(f);
    expect(readSecret("A")).toBe("from-env");
  });
});
