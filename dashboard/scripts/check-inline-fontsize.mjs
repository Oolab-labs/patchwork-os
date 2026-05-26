#!/usr/bin/env node
// Ratchet check: count raw `fontSize: <number>` literals in src/ and fail
// if the count exceeds BASELINE. Prevents new inline pixel sizes from
// sneaking in while we migrate existing sites to fs-* tokens.
//
// To lower the baseline: migrate inline fontSize to var(--fs-*), re-run,
// commit the new lower number here. Direction is monotonic — never raise.
//
// Usage: node scripts/check-inline-fontsize.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

// Bump DOWN as inline fontSize literals get migrated to var(--fs-*).
// Never bump UP. CI reviewer should reject any PR raising this number.
const BASELINE = 9;

const PATTERN = /fontSize:\s*[0-9]+(?:\.[0-9]+)?/g;

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

let total = 0;
const hits = [];
for (const file of walkFiles(SRC)) {
  const text = readFileSync(file, "utf8");
  const matches = text.match(PATTERN);
  if (matches) {
    total += matches.length;
    hits.push({ file: relative(ROOT, file), count: matches.length });
  }
}

if (total > BASELINE) {
  console.error(
    `\n✗ Inline fontSize ratchet failed: ${total} literals (baseline ${BASELINE}, +${total - BASELINE})`,
  );
  console.error("  New inline fontSize literals were added. Use var(--fs-*) tokens instead.");
  console.error("  Top offenders:");
  for (const { file, count } of hits.sort((a, b) => b.count - a.count).slice(0, 10)) {
    console.error(`    ${count.toString().padStart(3)}  ${file}`);
  }
  console.error("");
  process.exit(1);
}

if (total < BASELINE) {
  console.error(
    `\n✗ Inline fontSize ratchet drifted below baseline: ${total} < ${BASELINE}.`,
  );
  console.error(
    `  You migrated ${BASELINE - total} site(s) — thanks. Now lower the BASELINE in scripts/check-inline-fontsize.mjs to ${total} and commit so the ratchet locks in the new floor.`,
  );
  process.exit(1);
}

console.log(`inline fontSize ratchet ok (${total} literals, baseline ${BASELINE})`);
