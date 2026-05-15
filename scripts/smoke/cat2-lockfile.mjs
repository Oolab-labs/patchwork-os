/**
 * Category 2 — Lock file shape, permissions, cleanup.
 * Usage: node cat2-lockfile.mjs <port> <pid>
 */

import fs from "node:fs";
import {
  assert,
  assertEq,
  lockDir,
  lockExists,
  readLock,
  summary,
} from "./helpers.mjs";

const port = Number(process.argv[2]);
const pid = Number(process.argv[3]);
if (!port || !pid) {
  console.error("Usage: cat2-lockfile.mjs <port> <pid>");
  process.exit(1);
}

console.log("\n[CAT-2] Lock file");

const IS_WIN = process.platform === "win32";

// 2.1 Shape
const lock = readLock(port);
const REQUIRED = [
  "pid",
  "startedAt",
  "nonce",
  "workspace",
  "workspaceFolders",
  "ideName",
  "isBridge",
  "transport",
  "authToken",
];
for (const k of REQUIRED) assert(k in lock, `2.1 lock has field: ${k}`);
assertEq(lock.isBridge, true, "2.1 isBridge === true");
assertEq(lock.transport, "ws", "2.1 transport === 'ws'");
// PID match — on Windows the harness spawns with shell:true (required for
// the .cmd shim wrapper), so child.pid is the cmd.exe wrapper, not the
// bridge. The bridge's own pid in the lockfile is correct; the harness's
// reference pid is the wrong shape. Skip until the wrapper indirection
// is fixed.
if (!IS_WIN) {
  assertEq(lock.pid, pid, "2.1 pid matches bridge process");
}

// 2.2 / 2.3 Lock file + dir permissions — POSIX-only. NTFS doesn't honor
// POSIX modes; `chmod` is a no-op (accepted trade-off documented at
// src/lockfile.ts:73-75). Skip these assertions on win32 — same-user trust
// is the IDE-tooling norm for the token-confidentiality property.
if (!IS_WIN) {
  const lockPath = `${lockDir()}/${port}.lock`;
  const fileStat = fs.statSync(lockPath);
  const fileMode = (fileStat.mode & 0o777).toString(8);
  assertEq(fileMode, "600", "2.2 lock file permissions 0600");

  const dirStat = fs.statSync(lockDir());
  const dirMode = (dirStat.mode & 0o777).toString(8);
  assertEq(dirMode, "700", "2.3 lock dir permissions 0700");
}

// 2.4 Lock file removed on shutdown — POSIX kills the bridge with SIGTERM
// and the bridge's atexit unlink fires. Windows `process.kill(pid, 'SIGTERM')`
// is documented as TerminateProcess (no clean shutdown handlers run), so
// the lockfile cleanup path isn't exercised this way. Needs a separate
// win32 cleanup-on-exit verification (e.g. via the bridge's HTTP /shutdown
// endpoint).
if (!IS_WIN) {
  process.kill(pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  assert(!lockExists(port), "2.4 lock file removed after SIGTERM");
}

summary("CAT-2");
