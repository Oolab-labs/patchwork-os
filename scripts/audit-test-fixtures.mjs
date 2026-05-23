/**
 * Test fixture hygiene audit.
 *
 * Checks three things:
 *   1. Hardcoded /tmp/ paths — test files referencing /tmp/ directly
 *      (should use os.tmpdir() or tmp.dir() instead).
 *   2. process.env direct mutation without restore — process.env.FOO = 'x'
 *      not paired with afterEach/afterAll cleanup or vi.stubEnv.
 *   3. Missing vi.restoreAllMocks — test files that call vi.spyOn but never
 *      call vi.restoreAllMocks() or vi.resetAllMocks() in any cleanup block.
 *
 * Each category is compared against a ratcheting allowlist in
 * scripts/audit-test-fixtures-allowlist.json. New violations beyond the
 * allowlist fail CI. The allowlist only shrinks — remove entries once the
 * underlying issue is fixed.
 *
 * Usage:
 *   node scripts/audit-test-fixtures.mjs
 *
 * Exit code 0 = all checks pass. Exit code 1 = new violations found.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const ALLOWLIST_PATH = join(
  ROOT,
  "scripts",
  "audit-test-fixtures-allowlist.json",
);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all *.test.ts files under a directory. */
function walkTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Return a stable relative path from the repo root (forward slashes, cross-platform). */
function rel(absPath) {
  return relative(ROOT, absPath).replace(/\\/g, "/");
}

// ── scan ─────────────────────────────────────────────────────────────────────

const testFiles = walkTestFiles(SRC);

const hardcodedTmpPaths = [];
const envMutationWithoutRestore = [];
const spyOnWithoutRestore = [];

for (const file of testFiles) {
  const src = readFileSync(file, "utf8");
  const relPath = rel(file);

  // Check 1: hardcoded /tmp/ paths
  // Pattern: a non-alpha char followed by /tmp/ — catches strings like '/tmp/foo'
  // but not something like 'notmp/' or variable names containing 'tmp'.
  if (/[^a-zA-Z]\/tmp\//.test(src)) {
    hardcodedTmpPaths.push(relPath);
  }

  // Check 2: process.env direct mutation without restore
  // Looks for `process.env.UPPERCASE_VAR = ` assignments.
  // Only flags if the file does NOT also contain vi.stubEnv, afterEach/afterAll
  // with delete process.env, or a beforeEach/afterEach that saves/restores env.
  if (/process\.env\.[A-Z_]+ = /.test(src)) {
    const hasStubEnv = /vi\.stubEnv\s*\(/.test(src);
    const hasEnvDelete =
      /delete\s+process\.env\.[A-Z_]+/.test(src) ||
      /process\.env\.[A-Z_]+ = (?:undefined|original)/.test(src);
    const hasAfterCleanup =
      /after(?:Each|All)\s*\(\s*(?:async\s*)?\(\s*\)\s*=>/.test(src) &&
      hasEnvDelete;
    // vi.unstubAllEnvs restores everything stubEnv set
    const hasUnstubAll = /vi\.unstubAllEnvs\s*\(/.test(src);

    if (!hasStubEnv && !hasAfterCleanup && !hasUnstubAll) {
      envMutationWithoutRestore.push(relPath);
    }
  }

  // Check 3: vi.spyOn without vi.restoreAllMocks / vi.resetAllMocks
  if (/vi\.spyOn\s*\(/.test(src)) {
    const hasRestore =
      /vi\.restoreAllMocks\s*\(/.test(src) ||
      /vi\.resetAllMocks\s*\(/.test(src);
    if (!hasRestore) {
      spyOnWithoutRestore.push(relPath);
    }
  }
}

// ── load allowlist ────────────────────────────────────────────────────────────

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));

// ── compare against allowlist ─────────────────────────────────────────────────

/**
 * Ratchet check: fail if current violations are NOT a subset of the allowlist.
 * Returns list of new offenders (present in violations but not in allowlist).
 */
function newOffenders(violations, allowedList) {
  const allowed = new Set(allowedList);
  return violations.filter((v) => !allowed.has(v)).sort();
}

/**
 * Stale allowlist entries: present in allowlist but no longer violating.
 * We warn but do NOT fail CI — stale entries are just cleanup debt.
 */
function staleEntries(violations, allowedList) {
  const current = new Set(violations);
  return allowedList.filter((a) => !current.has(a)).sort();
}

// ── report ────────────────────────────────────────────────────────────────────

let issues = 0;

function fail(label, items) {
  if (!items.length) return;
  issues += items.length;
  console.error(`\n✗ ${label} (${items.length}):`);
  for (const item of items) console.error(`    - ${item}`);
}

function warn(label, items) {
  if (!items.length) return;
  console.warn(`\n⚠ ${label} (${items.length}) [non-blocking]:`);
  for (const item of items) console.warn(`    - ${item}`);
}

function ok(label) {
  console.log(`✓ ${label}`);
}

console.log(`\nTest Fixture Hygiene Audit\n${"─".repeat(40)}`);
console.log(`Scanned ${testFiles.length} test files\n`);

// Check 1: hardcoded /tmp/
const newTmp = newOffenders(hardcodedTmpPaths, allowlist.hardcodedTmpPaths);
const staleTmp = staleEntries(hardcodedTmpPaths, allowlist.hardcodedTmpPaths);
if (newTmp.length === 0) {
  ok(
    `Hardcoded /tmp/ paths: ${hardcodedTmpPaths.length} existing (all in allowlist)`,
  );
} else {
  fail(
    "New hardcoded /tmp/ paths — use os.tmpdir() instead (add to allowlist or fix)",
    newTmp,
  );
}
warn("Stale hardcodedTmpPaths allowlist entries (safe to remove)", staleTmp);

// Check 2: env mutation without restore
const newEnv = newOffenders(
  envMutationWithoutRestore,
  allowlist.envMutationWithoutRestore,
);
const staleEnv = staleEntries(
  envMutationWithoutRestore,
  allowlist.envMutationWithoutRestore,
);
if (newEnv.length === 0) {
  ok(
    `process.env mutation without restore: ${envMutationWithoutRestore.length} existing (all in allowlist)`,
  );
} else {
  fail(
    "New process.env mutations without restore — use vi.stubEnv() or afterEach cleanup",
    newEnv,
  );
}
warn(
  "Stale envMutationWithoutRestore allowlist entries (safe to remove)",
  staleEnv,
);

// Check 3: spyOn without restore
const newSpy = newOffenders(spyOnWithoutRestore, allowlist.spyOnWithoutRestore);
const staleSpy = staleEntries(
  spyOnWithoutRestore,
  allowlist.spyOnWithoutRestore,
);
if (newSpy.length === 0) {
  ok(
    `vi.spyOn without restoreAllMocks: ${spyOnWithoutRestore.length} existing (all in allowlist)`,
  );
} else {
  fail(
    "New vi.spyOn calls without vi.restoreAllMocks()/vi.resetAllMocks() — add afterEach cleanup",
    newSpy,
  );
}
warn("Stale spyOnWithoutRestore allowlist entries (safe to remove)", staleSpy);

console.log(
  `\n${issues === 0 ? "All checks passed." : `${issues} new violation(s) found — fix or add to allowlist before merging.`}`,
);

console.log(
  `\nStats: ${hardcodedTmpPaths.length} hardcodedTmpPaths · ${envMutationWithoutRestore.length} envMutationWithoutRestore · ${spyOnWithoutRestore.length} spyOnWithoutRestore`,
);

process.exit(issues > 0 ? 1 : 0);
