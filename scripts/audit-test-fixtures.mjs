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
 * underlying issue is fixed, and a STALE entry fails CI too: fixing a test
 * and leaving its exemption behind is an unfinished change, not a clean run.
 *
 * Usage:
 *   node scripts/audit-test-fixtures.mjs
 *
 * Exit code 0 = all checks pass. Exit code 1 = new violations, or stale
 * allowlist entries, or both.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
/** The dashboard is a separate package in the same repo, with its own tests. */
const DASHBOARD_SRC = join(ROOT, "dashboard", "src");
const ALLOWLIST_PATH = join(
  ROOT,
  "scripts",
  "audit-test-fixtures-allowlist.json",
);

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively collect test files under a directory.
 *
 * `.test.tsx` as well as `.test.ts`: the dashboard's component tests use the
 * TSX extension, so a `.test.ts`-only matcher would have skipped most of them
 * even once the dashboard root was added below.
 */
function walkTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestFiles(full, acc);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
    ) {
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

/**
 * Both test trees.
 *
 * The dashboard's 126 test files were never scanned: this walked `src/` alone,
 * so every fixture-hygiene rule stopped at the package boundary. Measured when
 * the boundary was removed — 7 hardcoded /tmp/ paths, 3 env mutations with no
 * restore and 4 `vi.spyOn` without restore, none of which any gate could see.
 *
 * One of them was introduced the same day by the session adding this scan
 * (#1430's sessionMemberId.test.ts set DASHBOARD_SESSION_SECRET in a
 * beforeEach and never cleaned up), which is the argument for the extension in
 * one line: the rules were fine, the surface was half.
 */
const testFiles = [
  ...walkTestFiles(SRC),
  ...(existsSync(DASHBOARD_SRC) ? walkTestFiles(DASHBOARD_SRC) : []),
];

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
 * These FAIL CI — see failStale() below for why they stopped being a note.
 */
function staleEntries(violations, allowedList) {
  const current = new Set(violations);
  return allowedList.filter((a) => !current.has(a)).sort();
}

// ── report ────────────────────────────────────────────────────────────────────

let issues = 0;
let staleIssues = 0;

function fail(label, items) {
  if (!items.length) return;
  issues += items.length;
  console.error(`\n✗ ${label} (${items.length}):`);
  for (const item of items) console.error(`    - ${item}`);
}

/**
 * A stale entry is a blocking failure, not a note.
 *
 * It was a note until 2026-08-17, and it printed on every run while the
 * script exited 0 — so nothing ever forced the prune and 20 accumulated.
 * A check that reports a real finding and still reports success is the
 * failure mode this repo keeps finding; the two sibling ratchets
 * (audit-lsp-tools, audit-shape-safety) already fail on their own stale
 * entries, which is why neither of them has any.
 *
 * Counted separately from `issues` because the remedy is the opposite one:
 * a new violation is fixed in the test or grandfathered into the allowlist,
 * a stale entry is DELETED from the allowlist. Reporting both under "new
 * violation(s) — fix or add to allowlist" would send the reader to add the
 * line they need to remove.
 */
function failStale(label, items) {
  if (!items.length) return;
  staleIssues += items.length;
  console.error(`\n✗ ${label} (${items.length}) — delete these lines:`);
  for (const item of items) console.error(`    - ${item}`);
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
failStale("Stale hardcodedTmpPaths allowlist entries", staleTmp);

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
failStale("Stale envMutationWithoutRestore allowlist entries", staleEnv);

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
failStale("Stale spyOnWithoutRestore allowlist entries", staleSpy);

const summary = [];
if (issues > 0)
  summary.push(
    `${issues} new violation(s) — fix the test, or add it to the allowlist`,
  );
if (staleIssues > 0)
  summary.push(
    `${staleIssues} stale allowlist entr${staleIssues === 1 ? "y" : "ies"} — delete from the allowlist`,
  );

console.log(
  `\n${summary.length === 0 ? "All checks passed." : `${summary.join("\n")}\n\nResolve before merging.`}`,
);

console.log(
  `\nStats: ${hardcodedTmpPaths.length} hardcodedTmpPaths · ${envMutationWithoutRestore.length} envMutationWithoutRestore · ${spyOnWithoutRestore.length} spyOnWithoutRestore`,
);

process.exit(issues + staleIssues > 0 ? 1 : 0);
