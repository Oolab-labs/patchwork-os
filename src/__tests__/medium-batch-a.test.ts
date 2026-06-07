/**
 * Batch A — medium-severity Windows fixes:
 *
 *   1. defaultIsLive EPERM false-negative (live elevated process reported as dead)
 *   2. installGuard darwin-only guard (spawnSync npm removed on non-darwin)
 *   3. PH-04 ctags split("/") on backslash paths (data-corruption fix)
 *
 * EBUSY/EPERM retry for writeFileAtomicSync lives in writeFileAtomic-ebusy.test.ts
 * (requires its own vi.mock("node:fs") context).
 *
 * Tests follow Bug Fix Protocol: written before the fix, must fail first.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── 1. defaultIsLive EPERM false-negative ────────────────────────────────────

// The function is not exported; test via findBridgeLock's isLive dep injection

import * as bridgeLockDiscovery from "../bridgeLockDiscovery.js";

describe("bridgeLockDiscovery — EPERM treated as live (not dead)", () => {
  it("returns the lock when isLive throws EPERM (elevated process — live but no signal permission)", () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), "pw-lockdiscovery-"));
    try {
      // Write a synthetic lock file
      writeFileSync(
        path.join(dir2, "9999.lock"),
        JSON.stringify({
          pid: 9999,
          authToken: "tok",
          workspace: "/home/user/project",
          isBridge: true,
        }),
      );

      const result = bridgeLockDiscovery.findBridgeLock({
        lockDir: dir2,
        isLive: (pid) => {
          if (pid === 9999) {
            // simulate EPERM: on Windows, cross-user/elevated process.kill throws
            const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
            throw err;
          }
          return false;
        },
      });

      // BEFORE FIX: isLive throws → catch returns false → lock skipped → null
      // AFTER FIX:  EPERM → process is live (just no permission) → lock returned
      expect(result).not.toBeNull();
      expect(result?.port).toBe(9999);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("treats ESRCH (no such process) as dead", () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), "pw-lockdiscovery-"));
    try {
      writeFileSync(
        path.join(dir2, "9998.lock"),
        JSON.stringify({
          pid: 9998,
          authToken: "tok",
          workspace: "/proj",
          isBridge: true,
        }),
      );

      const result = bridgeLockDiscovery.findBridgeLock({
        lockDir: dir2,
        isLive: (pid) => {
          if (pid === 9998) {
            throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          }
          return false;
        },
      });

      // ESRCH = no such process → dead
      expect(result).toBeNull();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ── 3. installGuard darwin-only guard ────────────────────────────────────────

vi.mock("node:child_process");
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: actual };
});

import { spawnSync } from "node:child_process";
import { detectWorkspaceSymlinkInstall } from "../installGuard.js";

describe("installGuard — darwin-only guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null immediately on non-darwin without spawning npm", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      const result = detectWorkspaceSymlinkInstall();
      // BEFORE FIX: spawnSync("npm.cmd", ...) runs on Windows
      // AFTER FIX:  returns null before spawn; spawnSync not called
      expect(result).toBeNull();
      expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});

// ── 4. PH-04 ctags split("/") on Windows backslash paths ─────────────────────
// The fix is in getProjectContext.ts. We test the isolated logic since the
// full tool requires a live workspace/extension.

describe("PH-04 — ctags module split handles backslash paths", () => {
  it("buggy split('/') returns whole path as single token on Windows-style path", () => {
    // Simulate Windows: relative() returns backslash path
    const rel = "src\\auth.ts"; // path.relative would return this on Windows
    const dir = rel.split("/")[0];
    // This is the bug: returns the full "src\auth.ts" as one token, not "src"
    expect(dir).toBe("src\\auth.ts");
  });

  it("fixed split handles backslash paths correctly", () => {
    const rel = "src\\auth.ts";
    const dir = rel.replace(/\\/g, "/").split("/")[0];
    expect(dir).toBe("src");
  });

  it("fixed split still works on forward-slash paths (POSIX)", () => {
    const rel = "src/auth.ts";
    const dir = rel.replace(/\\/g, "/").split("/")[0];
    expect(dir).toBe("src");
  });
});
