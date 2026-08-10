/**
 * PATCHWORK_HOME ratchet (#1265).
 *
 * `src/patchworkHome.ts` exists to make `PATCHWORK_HOME` authoritative, and
 * almost nothing used it: at the time this gate was written, 31 non-test files
 * still resolved `path.join(os.homedir(), ".patchwork")` by hand against 7
 * callers of the helper.
 *
 * The failure shape is why this is a gate and not a cleanup ticket. Setting the
 * variable relocates *some* state — config, roster — while the inbox, recipes,
 * connector tokens and the audit ledgers stay at `~/.patchwork`. Nothing errors.
 * For an audit trail that is the worst possible outcome: evidence lands
 * somewhere other than where the operator believes it does, and the only way to
 * notice is to go looking for a file that is silently still in the old place.
 *
 * ## A ratchet, not an allowlist
 *
 * Every entry in the companion JSON is a KNOWN BUG, not an approved exception.
 * The list may only shrink. A file that resolves the path by hand and is not
 * already listed fails CI, so the 31 cannot quietly become 32 while the
 * conversion proceeds in reviewable batches (the issue asks for ledgers →
 * inbox/recipes → connectors, not one sweep).
 *
 * A stale entry — a file that has been converted but not delisted — is reported
 * and fails, because a ratchet that silently tolerates stale entries stops
 * measuring anything. That is the same reasoning the in-flight ledger gate was
 * built on, after three manual sweeps failed to hold.
 *
 * Scope: non-test `src/**` only. Tests legitimately construct throwaway homes.
 *
 * Usage: node scripts/audit-patchwork-home.mjs
 * Exit:  0 clean · 1 drift · 2 script/config error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = "scripts/audit-patchwork-home-allowlist.json";

/** Hand-rolled resolution of the Patchwork home directory. */
const HARDCODED = /homedir\(\)\s*,\s*["']\.patchwork["']/;

/**
 * The helper itself. It must resolve the path by hand — that is its entire job,
 * including `legacyPatchworkHome()`, which exists precisely to name the OLD
 * location. Listing it on the ratchet would be recording the implementation as
 * a bug to be fixed, and the first person to "fix" it would break the override
 * for everyone.
 */
const SELF = "src/patchworkHome.ts";

function trackedSources() {
  const out = execFileSync("git", ["ls-files", "src/**/*.ts", "src/*.ts"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("__tests__"))
    .filter((f) => f !== SELF);
}

let allow;
try {
  const parsed = JSON.parse(readFileSync(path.join(root, ALLOWLIST), "utf8"));
  if (!Array.isArray(parsed.allow)) throw new Error("`allow` must be an array");
  allow = new Set(parsed.allow);
} catch (err) {
  console.error(`[patchwork-home] ${ALLOWLIST} unreadable: ${err.message}`);
  process.exit(2);
}

const offenders = new Set();
for (const file of trackedSources()) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    // Strip line comments first: this file's own explanation contains the very
    // pattern it looks for, and so do the notes left at converted call sites.
    const code = line.replace(/\/\/.*$/, "");
    if (HARDCODED.test(code)) {
      offenders.add(file);
      break;
    }
  }
}

const added = [...offenders].filter((f) => !allow.has(f)).sort();
const fixed = [...allow].filter((f) => !offenders.has(f)).sort();

console.log(
  `[patchwork-home] ${offenders.size} file(s) resolve ~/.patchwork by hand · ${allow.size} on the ratchet`,
);

if (added.length > 0) {
  console.error(
    `\n✗ ${added.length} NEW file(s) resolving ~/.patchwork by hand:\n`,
  );
  for (const f of added) console.error(`  • ${f}`);
  console.error(
    "\nUse patchworkPath(...) from src/patchworkHome.ts. Do NOT add the file to\n" +
      `${ALLOWLIST} — that list only shrinks (#1265).\n`,
  );
}

if (fixed.length > 0) {
  console.error(`\n✗ ${fixed.length} stale ratchet entr(y/ies) — now clean:\n`);
  for (const f of fixed) console.error(`  • ${f}`);
  console.error(
    `\nDelete these lines from ${ALLOWLIST}. A ratchet that tolerates stale\n` +
      "entries stops measuring anything.\n",
  );
}

if (added.length || fixed.length) process.exit(1);
console.log("[patchwork-home] OK — the ratchet holds.");
process.exit(0);
