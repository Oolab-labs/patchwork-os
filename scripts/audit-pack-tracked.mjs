#!/usr/bin/env node
/**
 * Nothing enters the published tarball that git does not track.
 *
 * ## The gap this closes
 *
 * `package.json`'s `files` includes `templates` wholesale. Git exclusions —
 * `.gitignore`, and especially `.git/info/exclude`, which is per-clone and
 * invisible to everyone else — have NO effect on npm packaging, and this repo
 * has an `.npmignore`, which makes npm ignore `.gitignore` entirely.
 *
 * So a file deliberately kept out of the repository is still packed, and a
 * release cut from a working copy that has one would publish it. Releases cut
 * in CI are safe by accident rather than by design: a fresh clone has no
 * untracked files to leak. The safety is a property of the runner, not of the
 * package, and that is the thing worth fixing.
 *
 * Measured when this was written: 1716 packed files, 1641 of them build output
 * under `dist/`, and 3 untracked non-dist files that would have shipped.
 *
 * ## Why a gate rather than a denylist
 *
 * `files` already carries name-based exclusions for the private tool modules.
 * That approach handled the compiled side and missed the template side — a
 * correct mechanism pointed at a partial surface, which is the recurring
 * defect here. A denylist protects exactly the cases someone thought of; this
 * protects every case, including the next one nobody thinks of.
 *
 * ## Why it does not print filenames by default
 *
 * The names of files someone deliberately kept out of a public repository are
 * themselves the disclosure — printing them into CI logs, scrollback or a
 * screenshot is the same leak one layer over. This reports a COUNT and the
 * containing directories, and tells you how to see the rest locally. Same
 * reasoning as the private-identifier gate, which prints which entry matched
 * and never the string.
 */

import { execFileSync } from "node:child_process";

const SHOW = process.argv.includes("--show");

/**
 * Packed paths that are build OUTPUT rather than source. Legitimately
 * untracked, and expected to be — `dist/` is gitignored and rebuilt.
 */
const BUILD_OUTPUT = [/^dist\//];

function packedFiles() {
  // `--dry-run` still runs the prepack/prepare lifecycle, which is why this is
  // wired into `prepublishOnly` (before pack) rather than into `prepack`,
  // where it would recurse.
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry?.files ?? []).map((f) => f.path);
}

function trackedFiles() {
  const raw = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(raw.split("\n").filter(Boolean));
}

let packed;
try {
  packed = packedFiles();
} catch (err) {
  // Fail LOUD rather than open. A gate that cannot run must not report a pass
  // — that is how `audit-in-flight` spent its whole life passing silently.
  console.error(
    `[pack-tracked] FAILED to enumerate the tarball: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const tracked = trackedFiles();
const offenders = packed.filter(
  (p) => !BUILD_OUTPUT.some((re) => re.test(p)) && !tracked.has(p),
);

if (offenders.length === 0) {
  console.log(
    `[pack-tracked] OK — ${packed.length} packed file(s); every non-dist one is tracked by git.`,
  );
  process.exit(0);
}

const dirs = [
  ...new Set(offenders.map((p) => p.split("/").slice(0, -1).join("/") || ".")),
];

console.error(
  `[pack-tracked] REFUSING — ${offenders.length} file(s) would be published that git does not track.`,
);
console.error(`  directories: ${dirs.join(", ")}`);
console.error(
  "  A file kept out of the repository must not be shipped in the tarball.",
);
console.error(
  "  Names are withheld on purpose: the name of a deliberately-excluded file is",
);
console.error(
  "  itself the disclosure. Run `node scripts/audit-pack-tracked.mjs --show`",
);
console.error("  locally to list them.");
if (SHOW) {
  console.error("");
  for (const o of offenders) console.error(`    ${o}`);
}
process.exit(1);
