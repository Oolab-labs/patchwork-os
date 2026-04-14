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
assertEq(lock.pid, pid, "2.1 pid matches bridge process");

// 2.2 Lock file permissions — 0600
const lockPath = `${lockDir()}/${port}.lock`;
const fileStat = fs.statSync(lockPath);
const fileMode = (fileStat.mode & 0o777).toString(8);
assertEq(fileMode, "600", "2.2 lock file permissions 0600");

// 2.3 Lock dir permissions — 0700
const dirStat = fs.statSync(lockDir());
const dirMode = (dirStat.mode & 0o777).toString(8);
assertEq(dirMode, "700", "2.3 lock dir permissions 0700");

// 2.4 Lock file removed on shutdown — kill bridge and wait
process.kill(pid, "SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
assert(!lockExists(port), "2.4 lock file removed after SIGTERM");

summary("CAT-2");
