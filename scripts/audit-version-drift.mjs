/**
 * Version-drift gate.
 *
 * `package.json` is the single source of truth for the version and the release
 * channel. This script fails CI when a version string in a *reader-facing*
 * document no longer agrees with it.
 *
 * WHY A GATE AND NOT AN ADVISORY. Its sibling `audit-docs-drift.mjs` is
 * deliberately advisory (always exits 0) because tool counts and coverage
 * thresholds move under routine PRs, and a hard gate there would fight normal
 * work. Version drift is different: it moves on a release, the fix is one
 * line, and the failure mode is a security document telling a reader to pin a
 * version line that no longer exists. `SECURITY.md` claimed the supported
 * channel was `0.2.0-beta.x` while npm's `beta` tag was `1.1.0-beta.4` — a
 * reader following it would have pinned to an unsupported line.
 *
 * ## Scope: four documents, not the whole tree
 *
 * Only the documents a reviewer actually reads are gated:
 *
 *   README.md · SECURITY.md · CONTRIBUTING.md · docs/privacy-policy.md
 *
 * `docs/migration.md`, `docs/listings.md`, `docs/install-ux-plan.md` and the
 * research/plan archive are *historical records*. A frozen old version in a
 * migration guide is correct, and gating them would produce a permanently red
 * build that everyone learns to ignore — which is worse than no gate.
 *
 * ## What counts as drift
 *
 * A semver-ish string (`1.1.0-beta.4`, `0.2.0-alpha.37`) whose MAJOR.MINOR.PATCH
 * differs from `package.json`, unless it appears in the allowlist. Floating tags
 * (`@beta`, `@latest`) are never flagged — they are correct by construction.
 *
 * The allowlist (`scripts/audit-version-drift-allowlist.json`) exists for
 * deliberate historical mentions, and every entry carries a reason. Same shape
 * as `audit-output-schema-allowlist.json`.
 *
 * Usage:  node scripts/audit-version-drift.mjs
 * Exit:   0 clean · 1 drift found · 2 script/config error
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Documents a reviewer reads. Everything else is out of scope by design. */
const GATED_FILES = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/privacy-policy.md",
];

/**
 * Semver-ish with an optional prerelease. Deliberately requires all three
 * numeric components so it does not match "node 22", "1.4.x" or a date.
 */
const VERSION_RE = /\b(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?\b/g;

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function loadAllowlist() {
  try {
    const raw = read("scripts/audit-version-drift-allowlist.json");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.allow))
      throw new Error("`allow` must be an array");
    return parsed.allow;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[version-drift] allowlist unreadable: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  let pkgVersion;
  try {
    pkgVersion = JSON.parse(read("package.json")).version;
  } catch (err) {
    console.error(`[version-drift] cannot read package.json: ${err.message}`);
    process.exit(2);
  }
  if (typeof pkgVersion !== "string") {
    console.error("[version-drift] package.json has no version string");
    process.exit(2);
  }

  const [pkgCore] = pkgVersion.split("-");
  const allow = loadAllowlist();
  /** An entry matches when the file and the exact version string both match. */
  const isAllowed = (file, version) =>
    allow.some((a) => a.file === file && a.version === version);

  const findings = [];
  const usedAllowEntries = new Set();

  for (const file of GATED_FILES) {
    let content;
    try {
      content = read(file);
    } catch (err) {
      console.error(`[version-drift] cannot read ${file}: ${err.message}`);
      process.exit(2);
    }
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(VERSION_RE)) {
        const [full, core] = m;
        if (core === pkgCore) continue; // same release line — fine
        // Dotted quads are not versions. `127.0.0.1` and `0.0.0.0` both match
        // the semver shape, and allowlisting them would be wrong — they are
        // not stale versions, they are IP addresses. Skip any match that sits
        // inside a longer dotted-numeric run, on either side.
        const before = line.slice(0, m.index);
        const after = line.slice(m.index + full.length);
        if (/\.\d$/.test(before) || /^\.\d/.test(after)) continue;
        if (isAllowed(file, full)) {
          usedAllowEntries.add(`${file}::${full}`);
          continue;
        }
        findings.push({
          file,
          line: i + 1,
          found: full,
          context: line.trim().slice(0, 120),
        });
      }
    });
  }

  // A stale allowlist entry is its own kind of rot: it silences a check for a
  // string nobody writes any more, and the next real drift on that line sails
  // through. Report it — but do not fail on it, because the fix is a deletion
  // and failing would block the very PR that removed the mention.
  const stale = allow.filter(
    (a) => !usedAllowEntries.has(`${a.file}::${a.version}`),
  );

  console.log(`[version-drift] package.json version: ${pkgVersion}`);
  console.log(
    `[version-drift] gated files: ${GATED_FILES.join(", ")}\n` +
      `[version-drift] allowlist entries: ${allow.length} (${stale.length} unused)`,
  );

  for (const s of stale) {
    console.log(
      `[version-drift] NOTE unused allowlist entry — ${s.file} :: ${s.version} (${s.reason ?? "no reason recorded"})`,
    );
  }

  if (findings.length === 0) {
    console.log("[version-drift] OK — no drift.");
    process.exit(0);
  }

  console.error(
    `\n[version-drift] FAIL — ${findings.length} version string(s) disagree with package.json (${pkgVersion}):\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  found "${f.found}"`);
    console.error(`    ${f.context}`);
  }
  console.error(
    `\nFix by updating the document, or — if the mention is a deliberate\n` +
      `historical reference — add it to scripts/audit-version-drift-allowlist.json\n` +
      `with a reason.\n`,
  );
  process.exit(1);
}

main();
