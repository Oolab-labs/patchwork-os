import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerSkipIdeValidCheckEnv,
  SKIP_IDE_VALID_CHECK_KEY,
} from "../settingsEnv.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-env-"));
  settingsPath = path.join(dir, "settings.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readSettings() {
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as {
    env?: Record<string, unknown>;
    hooks?: unknown;
    permissions?: unknown;
  };
}

describe("registerSkipIdeValidCheckEnv", () => {
  it("creates a fresh settings.json with the env block and the skip flag", () => {
    const r = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r.action).toBe("added");
    const s = readSettings();
    expect(s.env).toBeDefined();
    expect(s.env?.[SKIP_IDE_VALID_CHECK_KEY]).toBe("true");
  });

  it("adds the flag to an existing env block without dropping other vars", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { FOO: "bar" } }, null, 2),
    );
    const r = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r.action).toBe("added");
    const s = readSettings();
    expect(s.env?.FOO).toBe("bar");
    expect(s.env?.[SKIP_IDE_VALID_CHECK_KEY]).toBe("true");
  });

  it("is idempotent — second call reports already-present and does not churn", () => {
    registerSkipIdeValidCheckEnv(settingsPath);
    const before = readFileSync(settingsPath, "utf-8");
    const r2 = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r2.action).toBe("already-present");
    // Byte-for-byte unchanged on the no-op path.
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("preserves a user-pinned non-true value instead of clobbering it", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { [SKIP_IDE_VALID_CHECK_KEY]: "false" } }, null, 2),
    );
    const r = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r.action).toBe("preserved-user-value");
    expect(r.existingValue).toBe("false");
    // The user's value must survive untouched.
    const s = readSettings();
    expect(s.env?.[SKIP_IDE_VALID_CHECK_KEY]).toBe("false");
  });

  it("preserves unrelated top-level settings (hooks, permissions)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] },
        },
        null,
        2,
      ),
    );
    const r = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r.action).toBe("added");
    const s = readSettings();
    expect(s.permissions).toEqual({ allow: ["Read"] });
    expect(s.hooks).toEqual({ PreToolUse: [{ matcher: "*", hooks: [] }] });
    expect(s.env?.[SKIP_IDE_VALID_CHECK_KEY]).toBe("true");
  });

  it("reports an error (without clobbering) when env is not an object", () => {
    writeFileSync(settingsPath, JSON.stringify({ env: "oops" }, null, 2));
    const r = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r.action).toBe("error");
    expect(r.error).toMatch(/not an object/);
    // Original file is left intact — no destructive write on the error path.
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).env).toBe("oops");
  });

  it("reports an error on malformed JSON rather than throwing", () => {
    writeFileSync(settingsPath, "{ not json");
    const r = registerSkipIdeValidCheckEnv(settingsPath);
    expect(r.action).toBe("error");
    expect(typeof r.error).toBe("string");
  });
});
