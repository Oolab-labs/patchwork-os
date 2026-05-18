#!/usr/bin/env node
/**
 * Install the current workspace globally as a real copy (not a symlink).
 *
 * Reason: `npm install -g .` from a workspace under ~/Documents/ on macOS
 * makes /opt/homebrew/lib/node_modules/patchwork-os a symlink into Documents.
 * macOS TCC then blocks launchd-spawned processes from reading it (EPERM),
 * which silently breaks the LaunchAgent on first reload.
 *
 * This wrapper does `npm pack` → `npm install -g <tgz>` → cleanup. The result
 * is a normal real-copy install under the global prefix, outside TCC's
 * Documents/Desktop/Downloads protection.
 *
 * Use:  npm run install:global
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", cwd, ...opts });
}

function capture(cmd) {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

console.error("→ npm pack");
const packOutput = capture("npm pack --silent");
// `npm pack --silent` prints the tarball name on stdout (last non-empty line).
const tarball = packOutput
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .pop();
if (!tarball || !existsSync(join(cwd, tarball))) {
  console.error(
    `npm pack did not produce a tarball (got: ${tarball ?? "<empty>"})`,
  );
  process.exit(1);
}
console.error(`  packed: ${tarball}`);

try {
  console.error(`→ npm install -g ./${tarball}`);
  run(`npm install -g "./${tarball}"`);
} finally {
  try {
    rmSync(join(cwd, tarball));
    console.error(`  cleaned: ${tarball}`);
  } catch {
    /* ignore */
  }
}

console.error("✓ installed globally as a real copy");
