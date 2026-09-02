/**
 * `withFileLockSync` on Windows: a contender can see EPERM, not EEXIST.
 *
 * The lock is `openSync(lock, "wx")`, and the holder releases with
 * `unlinkSync`. On Windows a file whose delete is pending stays visible until
 * every handle closes, and an open against it fails with EPERM (or EBUSY /
 * EACCES depending on the filesystem filter in the way). The lock helper
 * treated anything but EEXIST as a real error and threw — so the losing
 * writer of two concurrent chained appends died on the reference CI matrix,
 * intermittently, on the Windows cells only.
 *
 * The same codes on POSIX are real permission errors and must still throw:
 * retrying EPERM on a read-only directory would spin until the timeout and
 * then report a timeout instead of the actual cause.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openFailures: { code: string; remaining: number } = {
  code: "EPERM",
  remaining: 0,
};

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (p: import("node:fs").PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith(".lock") && openFailures.remaining > 0) {
        openFailures.remaining--;
        const err = new Error(
          `${openFailures.code}: operation not permitted, open`,
        ) as NodeJS.ErrnoException;
        err.code = openFailures.code;
        throw err;
      }
      return (real.openSync as (...a: unknown[]) => number)(p, ...rest);
    },
  };
});

const { withFileLockSync } = await import("../fileLockSync.js");

let dir: string;
let file: string;
const realPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lock-win-"));
  file = path.join(dir, "ledger.jsonl");
  openFailures.remaining = 0;
});
afterEach(() => {
  setPlatform(realPlatform);
  rmSync(dir, { recursive: true, force: true });
});

describe("withFileLockSync under Windows contention codes", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    it(`treats ${code} from the lock open as contention on win32 and retries`, () => {
      setPlatform("win32");
      openFailures.code = code;
      openFailures.remaining = 3;
      const out = withFileLockSync(file, () => "ran", { timeoutMs: 2000 });
      expect(out).toBe("ran");
      expect(openFailures.remaining).toBe(0);
    });
  }

  it("still throws EPERM on POSIX — a real permission error must not become a timeout", () => {
    setPlatform("linux");
    openFailures.code = "EPERM";
    openFailures.remaining = 1;
    expect(() =>
      withFileLockSync(file, () => "ran", { timeoutMs: 500 }),
    ).toThrow(/EPERM/);
  });

  it("still times out on win32 when the code never clears, naming the lock", () => {
    setPlatform("win32");
    openFailures.code = "EPERM";
    openFailures.remaining = 1_000_000;
    expect(() =>
      withFileLockSync(file, () => "ran", { timeoutMs: 100 }),
    ).toThrow(/timed out/);
  });
});
