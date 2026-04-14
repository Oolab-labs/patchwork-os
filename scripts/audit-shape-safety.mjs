/**
 * Shape-safety audit for extensionClient.ts.
 *
 * Checks that every method in ExtensionClient that calls this.proxy<T>() is either:
 *   (a) in the grandfathered allowlist (scripts/audit-shape-safety-allowlist.json), OR
 *   (b) wrapped in tryRequest<T>() or validatedRequest<T>() instead.
 *
 * Root cause context: 8 latent shape-mismatch bugs in v2.25.18–24 all traced to blind
 * proxy<T>() casts with no runtime validation. Helpers added in v2.25.22:
 *   - tryRequest<T>()         — auto-unwraps {error}/{success:false,error} to null
 *   - validatedRequest<T>()   — runtime shape predicate before TypeScript cast
 *
 * New methods must NOT use this.proxy<T>(). If a grandfathered site is migrated,
 * remove it from the allowlist so the gate prevents re-introduction.
 *
 * Usage:
 *   node scripts/audit-shape-safety.mjs
 *
 * Exit code 0 = all checks pass. Exit code 1 = violations found.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const clientPath = path.join(root, "src", "extensionClient.ts");
const allowlistPath = path.join(__dirname, "audit-shape-safety-allowlist.json");

// ── load sources ──────────────────────────────────────────────────────────────

const src = readFileSync(clientPath, "utf8");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

const allowedMethods = new Set(allowlist.allowlist.map((e) => e.clientMethod));

// ── find all proxy<T> call sites ─────────────────────────────────────────────
//
// Pattern: `this.proxy<...>(` — matches both single-line and multi-line.
// We walk line-by-line to capture method context (enclosing async function).

const lines = src.split("\n");

/**
 * Given a line index, walk backwards to find the name of the enclosing
 * async method. Returns the method name or null if not found within 20 lines.
 */
function findEnclosingMethod(lineIdx) {
  for (let i = lineIdx; i >= Math.max(0, lineIdx - 20); i--) {
    const m = lines[i].match(/async\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (m) return m[1];
  }
  return null;
}

const proxyCallPattern = /this\.proxy\s*</;
const violations = [];
const allowlistHits = [];
const notInAllowlist = [];

for (let i = 0; i < lines.length; i++) {
  if (!proxyCallPattern.test(lines[i])) continue;

  const lineNum = i + 1; // 1-based for display
  const methodName = findEnclosingMethod(i);

  if (!methodName) {
    violations.push(
      `Line ${lineNum}: this.proxy<T>() call outside a named async method — manual review required`,
    );
    continue;
  }

  if (allowedMethods.has(methodName)) {
    // Verify the allowlist entry line number is approximately correct (within ±5)
    const entry = allowlist.allowlist.find(
      (e) => e.clientMethod === methodName,
    );
    const lineDrift = Math.abs((entry?.line ?? 0) - lineNum);
    allowlistHits.push({ methodName, lineNum, lineDrift });
  } else {
    notInAllowlist.push(
      `Line ${lineNum}: ${methodName}() uses this.proxy<T>() — use tryRequest<T>() or validatedRequest<T>() instead`,
    );
  }
}

// Check for stale allowlist entries (method no longer uses proxy)
const foundMethodNames = new Set([
  ...allowlistHits.map((h) => h.methodName),
  ...notInAllowlist
    .map((v) => v.match(/^Line \d+: (\w+)\(\)/)?.[1])
    .filter(Boolean),
]);

const staleAllowlist = allowlist.allowlist.filter(
  (e) => !foundMethodNames.has(e.clientMethod),
);

// ── report ────────────────────────────────────────────────────────────────────

let issues = 0;

function fail(label, items) {
  if (!items.length) return;
  issues += items.length;
  console.error(`\n✗ ${label} (${items.length}):`);
  for (const item of items) console.error(`    - ${item}`);
}

function ok(label) {
  console.log(`✓ ${label}`);
}

console.log(`\nShape-Safety Audit (extensionClient.ts)\n${"─".repeat(40)}`);

if (notInAllowlist.length === 0) {
  ok("No new proxy<T>() calls outside the allowlist");
} else {
  fail(
    "proxy<T>() calls NOT in allowlist — migrate to tryRequest/validatedRequest",
    notInAllowlist,
  );
}

if (staleAllowlist.length === 0) {
  ok("Allowlist has no stale entries");
} else {
  fail(
    "Allowlist entries no longer found in source — remove them (migrations done!)",
    staleAllowlist.map(
      (e) =>
        `${e.clientMethod} (was line ${e.line}) — migration completed, remove from allowlist`,
    ),
  );
}

// Show drift warnings but don't fail — line numbers shift as code is edited
for (const { methodName, lineNum, lineDrift } of allowlistHits) {
  if (lineDrift > 10) {
    console.warn(
      `  ⚠ Allowlist line number drift for ${methodName}: allowlist says ~${allowlist.allowlist.find((e) => e.clientMethod === methodName)?.line}, found at ${lineNum}. Update allowlist.`,
    );
  }
}

if (violations.length > 0) {
  fail("Unexpected proxy<T>() call sites (no enclosing method)", violations);
}

console.log(
  `\n${
    issues === 0
      ? `All checks passed. ${allowlistHits.length} grandfathered site(s) in allowlist; ${notInAllowlist.length} new violation(s).`
      : `${issues} issue(s) found — fix before merging.`
  }`,
);

if (issues === 0 && allowlistHits.length > 0) {
  console.log(
    `\nGrandfathered sites (migrate these when touching the affected methods):`,
  );
  for (const entry of allowlist.allowlist) {
    console.log(
      `  - ${entry.clientMethod}() [line ~${entry.line}]: ${entry.todo}`,
    );
  }
}

process.exit(issues > 0 ? 1 : 0);
