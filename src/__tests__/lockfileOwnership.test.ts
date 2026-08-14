/**
 * #1359 — the lock file must not be taken from, or deleted by, someone who no
 * longer owns it.
 *
 * `~/.claude/ide/<port>.lock` is how every CLI verb and the dashboard find the
 * bridge and its auth token. Lose it, or point it at the wrong process, and a
 * perfectly healthy bridge becomes unreachable — every lookup 401s or reports
 * "no bridge running", with nothing in the logs pointing at the lock. That is
 * how this was originally diagnosed as an auth bug.
 *
 * Two unguarded paths, both of which already had the machinery to guard
 * themselves:
 *
 *  - `delete()` unlinked unconditionally. A process shutting down AFTER a
 *    successor had claimed the same path removed the SUCCESSOR's lock. The
 *    class already carries `ownNonce` for exactly this purpose and
 *    `cleanStale()` already uses it; `delete()` did not.
 *  - `write()` force-removed an existing lock on EEXIST with no liveness
 *    check, so a starting process could take the lock from a LIVE bridge.
 *    `cleanStale()` already does `process.kill(pid, 0)`; `write()` did not.
 *
 * This is the same bug class as #1341 one layer down: a writer assuming it is
 * the only actor, and clobbering a record it never checked it still owned.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockFileManager } from "../lockfile.js";
import { Logger } from "../logger.js";

let tmpDir: string;
let logger: Logger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockown-test-"));
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
  logger = new Logger(false);
});

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const lockPathFor = (port: number) => path.join(tmpDir, "ide", `${port}.lock`);

const readLock = (port: number) =>
  JSON.parse(fs.readFileSync(lockPathFor(port), "utf-8")) as {
    pid: number;
    nonce: string;
    authToken: string;
  };

/** A lock file as another process would have written it. */
const writeForeignLock = (port: number, pid: number, token = "foreign") => {
  fs.mkdirSync(path.join(tmpDir, "ide"), { recursive: true });
  fs.writeFileSync(
    lockPathFor(port),
    JSON.stringify({
      pid,
      startedAt: Date.now(),
      nonce: "foreign-nonce",
      workspace: "/somewhere",
      workspaceFolders: ["/somewhere"],
      ideName: "other",
      isBridge: true,
      transport: "ws",
      authToken: token,
    }),
    { mode: 0o600 },
  );
};

describe("lock file ownership (#1359)", () => {
  describe("delete()", () => {
    /**
     * The outage. An old process finishing its shutdown must not remove the
     * lock a NEW bridge has already written — the new bridge stays healthy
     * while becoming invisible to every client.
     */
    it("does not delete a lock that another process now owns", () => {
      const mgr = new LockFileManager(logger);
      mgr.write(45001, "mine", ["/ws"], "vscode");

      // A successor claims the same path.
      writeForeignLock(45001, process.pid, "successor-token");

      mgr.delete();

      expect(
        fs.existsSync(lockPathFor(45001)),
        "the successor's lock must survive our shutdown",
      ).toBe(true);
      expect(readLock(45001).authToken).toBe("successor-token");
    });

    it("still deletes its own lock", () => {
      const mgr = new LockFileManager(logger);
      mgr.write(45002, "mine", ["/ws"], "vscode");
      expect(fs.existsSync(lockPathFor(45002))).toBe(true);

      mgr.delete();

      expect(fs.existsSync(lockPathFor(45002))).toBe(false);
    });
  });

  describe("write()", () => {
    /**
     * Reclaiming is CORRECT here, and this test pins that deliberately.
     *
     * `write()` runs only after `findAndListen()` has bound the port, so we
     * demonstrably own the port the lock names — whoever wrote it is not
     * serving it, alive or not. A first draft of this fix refused when the
     * recorded pid was alive; that protects nothing and breaks a real case,
     * because pids are recycled and a stale lock naming a reused pid would
     * stop the bridge starting at all.
     *
     * The ownership bug is in `delete()`, guarded by nonce above.
     */
    it("reclaims the lock even when the recorded pid is alive (we own the port)", () => {
      writeForeignLock(45003, process.pid, "stale-but-live-pid");
      const mgr = new LockFileManager(logger);

      expect(() => mgr.write(45003, "mine", ["/ws"], "vscode")).not.toThrow();
      expect(readLock(45003).authToken).toBe("mine");
    });

    /** The common case: a crashed bridge left its lock behind. Reclaiming it
     *  must keep working, or every unclean shutdown needs manual cleanup. */
    it("reclaims a lock whose owner is gone", () => {
      writeForeignLock(45004, -1, "dead-bridge-token");
      const mgr = new LockFileManager(logger);

      expect(() => mgr.write(45004, "mine", ["/ws"], "vscode")).not.toThrow();
      expect(readLock(45004).authToken).toBe("mine");
      expect(readLock(45004).pid).toBe(process.pid);
    });

    /** A corrupt lock must not wedge startup forever — it names no owner we
     *  can verify, and "we cannot tell" here means the file is junk, not that
     *  a live process is behind it. */
    it("reclaims an unparseable lock", () => {
      fs.mkdirSync(path.join(tmpDir, "ide"), { recursive: true });
      fs.writeFileSync(lockPathFor(45005), "{ not json");
      const mgr = new LockFileManager(logger);

      expect(() => mgr.write(45005, "mine", ["/ws"], "vscode")).not.toThrow();
      expect(readLock(45005).authToken).toBe("mine");
    });
  });
});
