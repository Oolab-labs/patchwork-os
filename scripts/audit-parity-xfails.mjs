/**
 * Runner-parity xfail ratchet — Issue #850.
 *
 * `src/recipes/__tests__/runner.behavioral-parity.test.ts` drives the SAME
 * scenario through the flat (yamlRunner) and chained (chainedRunner) execution
 * paths. Where the two genuinely diverge today, the gap is recorded with an
 * `it.fails(...)` marker (a test whose body is EXPECTED to throw). That set of
 * markers IS the runner-unification backlog.
 *
 * This gate enforces a one-way ratchet: the number of xfail markers may only
 * DECREASE. A new divergence (more `it.fails`) fails CI — drift must be fixed,
 * not documented-and-forgotten. When a gap is closed, the marker is converted
 * to a passing `it(...)` and the baseline below is lowered to match (the script
 * prints the exact new value to use).
 *
 * Usage:
 *   node scripts/audit-parity-xfails.mjs
 *
 * Exit 0 = count <= baseline. Exit 1 = NEW xfail introduced (count > baseline).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const target = path.join(
  root,
  "src",
  "recipes",
  "__tests__",
  "runner.behavioral-parity.test.ts",
);

// Baseline = the documented divergences that exist today. Lower this (never
// raise it) as gaps are closed. Current xfails:
//   1. chained usdMax not enforced through dispatchRecipe (no price table threaded)
//   2. AbortSignal not threaded through dispatchRecipe to chainedRunner
//   3. flat runner has no AbortSignal / cancellation seam
const BASELINE = 3;

const raw = readFileSync(target, "utf8");

// Strip block + line comments so a `it.fails(...)` mention in documentation
// does not count as a marker — only real call sites do.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Count xfail markers: it.fails( / test.fails( / describe.fails( (with any
// intervening chain like .only). The `.fails(` call form is matched
// specifically so a string literal mentioning "fails" does not count.
const matches =
  src.match(/\b(?:it|test|describe)(?:\.\w+)*\.fails\s*\(/g) ?? [];
const count = matches.length;

if (count > BASELINE) {
  console.error(
    `✗ runner-parity xfail ratchet: found ${count} \`it.fails\` markers, baseline is ${BASELINE}.`,
  );
  console.error(
    "  A NEW flat/chained runner divergence was introduced. Fix the drift so",
  );
  console.error(
    "  both paths behave identically — do not paper over it with a new xfail.",
  );
  console.error(`  File: ${path.relative(root, target)}`);
  process.exit(1);
}

if (count < BASELINE) {
  console.error(
    `✗ runner-parity xfail ratchet: found ${count} \`it.fails\` markers but baseline is ${BASELINE}.`,
  );
  console.error(
    `  A divergence was closed — ratchet DOWN: set BASELINE = ${count} in`,
  );
  console.error(`  ${path.relative(root, "scripts/audit-parity-xfails.mjs")}.`);
  process.exit(1);
}

console.log(
  `✓ runner-parity xfail ratchet: ${count} documented divergence(s), matches baseline ${BASELINE}.`,
);
process.exit(0);
