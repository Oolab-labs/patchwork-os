/**
 * OAuth state store persistence — survives bridge restart.
 *
 * Bug repro: prior implementation kept states in a process-local Map. A
 * bridge restart between /authorize and /callback dropped the state →
 * "invalid state" → user re-initiates OAuth. Fix persists the map to
 * disk under PATCHWORK_HOME/tokens/ and rehydrates on construction.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOAuthStateStore } from "../oauthStateStore.js";

describe("oauthStateStore persistence", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "pw-oauth-state-"));
    prevHome = process.env.PATCHWORK_HOME;
    process.env.PATCHWORK_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prevHome;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it("rehydrates from disk after a simulated restart", () => {
    const a = createOAuthStateStore({ namespace: "test-conn" });
    expect(a.add("state-abc")).toBe(true);
    expect(a.size()).toBe(1);

    // Simulate a bridge restart: drop the in-memory store, build a fresh
    // one with the same namespace pointing at the same PATCHWORK_HOME.
    const b = createOAuthStateStore({ namespace: "test-conn" });
    expect(b.consume("state-abc")).toBe(true);
    // Second consume must fail — single-use guarantee preserved across restart.
    const c = createOAuthStateStore({ namespace: "test-conn" });
    expect(c.consume("state-abc")).toBe(false);
  });

  it("isolates namespaces", () => {
    const a = createOAuthStateStore({ namespace: "ns-a" });
    const b = createOAuthStateStore({ namespace: "ns-b" });
    a.add("shared");
    expect(b.consume("shared")).toBe(false);
    expect(a.consume("shared")).toBe(true);
  });

  it("does not rehydrate expired entries", () => {
    const a = createOAuthStateStore({ namespace: "expiry", ttlMs: 1 });
    a.add("stale");
    // Wait past TTL.
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    const b = createOAuthStateStore({ namespace: "expiry", ttlMs: 1 });
    expect(b.consume("stale")).toBe(false);
  });

  it("writes state file with mode 0600", () => {
    const a = createOAuthStateStore({ namespace: "perms" });
    a.add("x");
    // File path: PATCHWORK_HOME/tokens/oauth-state.<namespace>.json
    const file = join(tmpHome, "tokens", "oauth-state.perms.json");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // File is plain JSON (state is a nonce, not a secret — single-use, short-lived).
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(typeof parsed).toBe("object");
    expect(Object.keys(parsed)).toContain("x");
  });

  it("memory-only mode (no namespace) skips disk IO", () => {
    const a = createOAuthStateStore();
    a.add("mem-only");
    // No oauth-state file should appear in the tokens dir.
    const tokensDir = join(tmpHome, "tokens");
    let listed: string[] = [];
    try {
      listed = require("node:fs").readdirSync(tokensDir);
    } catch {
      // tokens dir may not exist — that's fine, means no IO happened.
    }
    expect(listed.some((f) => f.startsWith("oauth-state."))).toBe(false);
  });
});
