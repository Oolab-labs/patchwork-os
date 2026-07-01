/**
 * findActiveLockFile — regression test.
 *
 * Pre-fix this picked the newest-mtime `*.lock` file in the directory with
 * no `isBridge` filter and no `PATCHWORK_BRIDGE_PORT` support — the same
 * lock-discovery bug already fixed 3x elsewhere (shim, status, task runner).
 * An IDE-owned lock (no `isBridge: true`) with a fresher mtime than the real
 * bridge lock would shadow it, and `PATCHWORK_BRIDGE_PORT` was ignored.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findActiveLockFile } from "../tokenEfficiency.js";

describe("findActiveLockFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("ignores an IDE-owned lock even if it has a newer mtime than the real bridge lock", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-lock-test-"));

    // Real bridge lock, written first (older mtime).
    writeFileSync(
      path.join(dir, "3101.lock"),
      JSON.stringify({ pid: process.pid, authToken: "tok", isBridge: true }),
    );
    // IDE-owned lock (no isBridge flag), written after → newer mtime.
    writeFileSync(
      path.join(dir, "9999.lock"),
      JSON.stringify({ pid: process.pid, authToken: "tok2" }),
    );

    const found = findActiveLockFile(dir);
    expect(found?.port).toBe(3101);
  });
});
