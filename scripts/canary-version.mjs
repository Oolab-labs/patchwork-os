#!/usr/bin/env node
/**
 * The npm version a canary build publishes under (publish-npm.yml,
 * `publish-canary`).
 *
 * A canary must sort ABOVE its base and BELOW the next release:
 *   - prerelease base `1.2.0-beta.3` → `1.2.0-beta.3.canary.<run>`
 *     (unchanged from before: above beta.3, below beta.4);
 *   - stable base `1.2.5` → `1.2.6-canary.<run>` (above 1.2.5, below 1.2.6).
 *
 * The old shape `<base>.canary.<run>` is not semver for a stable base
 * (`1.2.5.canary.1000`), so npm refused every canary from the first stable
 * release on and the `canary` dist-tag froze.
 *
 * Usage: node scripts/canary-version.mjs <runNumber>   (reads package.json)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

export function canaryVersion(base, run) {
  const m = CORE.exec(String(base));
  if (!m) throw new Error(`not a semver base version: ${JSON.stringify(base)}`);
  if (!Number.isInteger(run) || run < 0) {
    throw new Error(`run number must be a non-negative integer, got ${run}`);
  }
  const [, major, minor, patch, pre] = m;
  return pre
    ? `${base}.canary.${run}`
    : `${major}.${minor}.${Number(patch) + 1}-canary.${run}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = Number(process.argv[2]);
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  process.stdout.write(`${canaryVersion(pkg.version, run)}\n`);
}
