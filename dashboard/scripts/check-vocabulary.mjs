#!/usr/bin/env node
// Ratchet check: count user-facing uses of banned synonyms for Patchwork's
// canonical vocabulary. Prevents drift like "Workflow" / "Job" / "Execution"
// creeping into headings + microcopy while we have "Recipe" / "Run" / "Task"
// already defined in src/lib/glossary.ts as canonical.
//
// Why monotonic ratchets, not strict zero: the codebase has legitimate uses
// of these words (comment text, code identifiers, mock data). The baseline
// captures the current count; new PRs can only bring it down.
//
// Banned words:
//   Workflow / Workflows  -> use Recipe / Recipes
//   Execution             -> use Run (the noun) or "executes" (verb)
//
// We deliberately DO NOT ban "automation" — Patchwork has a real --automation
// feature (hooks) distinct from recipes. Linting that would conflate them.
//
// Skipped paths:
//   - __tests__ (test fixtures often use synonyms intentionally)
//   - mockData.ts (mock prose is not user-facing copy we control today)
//   - any comment-only matches (the user never sees JSDoc / inline comments)
//
// Usage: node scripts/check-vocabulary.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

const BANNED = [
  { pattern: /\b[Ww]orkflows?\b/g, suggest: "Recipe / Recipes" },
  { pattern: /\bExecutions?\b/g, suggest: "Run / Runs (noun) or 'executes' (verb)" },
];

// Bump DOWN as drift gets normalized. Never bump UP.
//
// Execution=2: both are the "Execution Plan" heading on /runs/[seq]
// (one in the live header, one in the modal title). That heading is
// the runs-page-specific name for the dry-run plan view; keeping the
// term here doesn't conflate with /runs's "run" noun. If the heading
// gets renamed, drop this to 0.
const BASELINE = {
  Workflow: 0,
  Execution: 2,
};

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
      yield* walkFiles(full);
    } else if (/\.(tsx?|jsx?)$/.test(name)) {
      yield full;
    }
  }
}

/**
 * Strip block comments + line comments + JSX comments so banned-word matches
 * inside source-code commentary don't drive the ratchet. User-facing copy
 * lives in string literals + JSX prose, which survive this scrub.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
}

function classify(word) {
  if (/workflow/i.test(word)) return "Workflow";
  if (/execution/i.test(word)) return "Execution";
  return null;
}

const counts = { Workflow: 0, Execution: 0 };
const hitsByFile = new Map();

for (const file of walkFiles(SRC)) {
  if (file.endsWith("mockData.ts")) continue;
  const raw = readFileSync(file, "utf8");
  const text = stripComments(raw);
  for (const { pattern } of BANNED) {
    const matches = text.match(pattern);
    if (!matches) continue;
    for (const m of matches) {
      const bucket = classify(m);
      if (!bucket) continue;
      counts[bucket]++;
      const key = relative(ROOT, file);
      hitsByFile.set(key, (hitsByFile.get(key) ?? 0) + 1);
    }
  }
}

let failed = false;
for (const [bucket, baseline] of Object.entries(BASELINE)) {
  const got = counts[bucket];
  if (got > baseline) {
    console.error(
      `\n✗ Vocabulary ratchet failed: ${got} '${bucket}' usages (baseline ${baseline}, +${got - baseline})`,
    );
    const suggest = BANNED.find((b) => classify(b.pattern.source) === bucket || b.pattern.source.toLowerCase().includes(bucket.toLowerCase()))?.suggest;
    if (suggest) console.error(`  Prefer: ${suggest}`);
    failed = true;
  } else if (got < baseline) {
    console.error(
      `\n✗ Vocabulary ratchet drifted below baseline for '${bucket}': ${got} < ${baseline}.`,
    );
    console.error(
      `  You removed ${baseline - got} usage(s) — thanks. Now lower BASELINE.${bucket} in scripts/check-vocabulary.mjs to ${got} and commit so the ratchet locks in the new floor.`,
    );
    failed = true;
  }
}

if (failed) {
  if (hitsByFile.size > 0) {
    console.error("  Files with banned terms:");
    for (const [file, n] of [...hitsByFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)) {
      console.error(`    ${n.toString().padStart(3)}  ${file}`);
    }
    console.error("");
  }
  process.exit(1);
}

console.log(
  `vocabulary ratchet ok (Workflow=${counts.Workflow}/${BASELINE.Workflow}, Execution=${counts.Execution}/${BASELINE.Execution})`,
);
