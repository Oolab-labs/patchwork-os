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
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Private, gitignored recipe tools. They are EXCLUDED from the published npm
// tarball (package.json `files`) so they never leak to the public registry,
// but the local global install still needs them for the local crypto brief —
// so we copy them back from the freshly-built local dist after `npm install -g`.
const PRIVATE_TOOL_BASES = ["altscan", "market", "ta", "taLedger", "watchlist"];
const PRIVATE_TOOL_EXTS = [".js", ".d.ts", ".js.map"];

const cwd = process.cwd();

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", cwd, ...opts });
}

function capture(cmd) {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

// Build FIRST. `npm pack` tars whatever is already in dist/ — it does NOT run
// the build (only `prepublishOnly` builds, and that runs on `npm publish`, never
// on `npm pack`). Without this, install:global silently ships a STALE dist (e.g.
// freshly-merged code missing its latest wiring), and the global bridge runs old
// behaviour even though the source is current. Always rebuild before packing.
console.error(
  "→ npm run build (fresh dist — npm pack alone tars a stale dist/)",
);
run("npm run build");

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

// Restore the private tools the published tarball intentionally omits. Fail-soft:
// a clean checkout without the private sources simply has nothing to copy.
try {
  const globalRoot = capture("npm root -g");
  const srcDir = join(cwd, "dist", "recipes", "tools");
  const destDir = join(globalRoot, "patchwork-os", "dist", "recipes", "tools");
  let copied = 0;
  if (existsSync(destDir)) {
    for (const base of PRIVATE_TOOL_BASES) {
      for (const ext of PRIVATE_TOOL_EXTS) {
        const from = join(srcDir, `${base}${ext}`);
        if (existsSync(from)) {
          cpSync(from, join(destDir, `${base}${ext}`));
          copied++;
        }
      }
    }
  }
  if (copied > 0) {
    console.error(
      `  restored ${copied} private tool file(s) into the global install`,
    );
  }
} catch (e) {
  console.error(
    `  (skipped private-tool restore: ${e instanceof Error ? e.message : String(e)})`,
  );
}

console.error("✓ installed globally as a real copy");
