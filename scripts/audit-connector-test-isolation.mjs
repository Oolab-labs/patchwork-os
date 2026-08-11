/**
 * Connector-test store isolation gate (#1345).
 *
 * `src/connectors/__tests__/todoist.test.ts` deleted a REAL credential from the
 * developer's machine — `~/.patchwork/tokens/patchwork-os.todoist.enc`, a live
 * Todoist connection. Not a fixture.
 *
 * The path is short and entirely ordinary:
 *
 *   handleTodoistDisconnect → clearTokens → deleteSecretJsonSync
 *     → unlinkSync(`<PATCHWORK_HOME>/tokens/patchwork-os.<provider>.enc`)
 *
 * That unlink is UNCONDITIONAL — the storage-backend branch above it only
 * decides whether the keychain is cleared as well. So the only thing standing
 * between a disconnect test and the developer's real credentials is the value
 * of `PATCHWORK_HOME` at the moment the test runs. Several describes in that
 * file set it, then unset it in `afterEach`; a later describe called disconnect
 * with it unset, and `getStorageDir()` fell back to `homedir()`.
 *
 * ## Why this needs a gate rather than a fix
 *
 * Two properties make it invisible to review:
 *
 *  1. **No single block is wrong.** Bisecting the file by `describe` shows every
 *     block individually harmless; only the combination deletes. The bug lives
 *     in the ordering between blocks, which is exactly what a reviewer reading
 *     one hunk cannot see.
 *
 *  2. **The obvious sandbox does not work.** Overriding `HOME` looks like
 *     isolation and provides none: `delete process.env.HOME` makes
 *     `os.homedir()` fall back to the passwd entry, which returns the real home
 *     regardless of what the parent process set. A HOME-based guard is a check
 *     that cannot fail. `PATCHWORK_HOME` is the only knob `getStorageDir()`
 *     honours ahead of `homedir()`.
 *
 * `scripts/audit-patchwork-home.mjs` scopes itself to non-test sources, on the
 * reasoning that "tests legitimately construct throwaway homes". They do — and
 * then they unset the variable, and the throwaway home silently becomes the
 * real one. This gate is the complement of that one.
 *
 * ## What it flags
 *
 * Only the dangerous COMBINATION: a file that can unlink a credential
 * (`clearTokens()` / `handle*Disconnect()`) while `PATCHWORK_HOME` is unset or
 * never set. Unsetting the sandbox in a file that deletes nothing is untidy,
 * not harmful — forbidding it outright would flag 104 sites across 75 files
 * for no safety gain, and a gate nobody can land is not a gate.
 *
 * Restore the sandbox value rather than deleting the variable. Unsetting it is
 * not a return to a neutral state; it re-points the store at the real machine.
 *
 * ## A ratchet, not an allowlist
 *
 * Entries in the companion JSON are files that call a disconnect/clear path
 * with no `PATCHWORK_HOME` isolation at all. They are KNOWN HAZARDS, not
 * approved exceptions, and the list may only shrink. A canary run showed them
 * latent rather than actively deleting, which is why they are recorded instead
 * of edited blind — but a new one must not appear.
 *
 * Usage: node scripts/audit-connector-test-isolation.mjs
 * Exit:  0 clean · 1 drift · 2 script/config error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = "scripts/audit-connector-test-isolation-allowlist.json";

/** Unsetting the sandbox re-points the store at the developer's real home. */
const UNSETS_HOME = /delete\s+process\.env\.PATCHWORK_HOME/;

/** Calls that reach `deleteSecretJsonSync` and unlink a credential file. */
const DELETES_CREDENTIAL = /\bclearTokens\s*\(\)|handle\w*Disconnect\s*\(\)/;

/** Any mention at all — the ratchet only asks whether isolation was attempted. */
const MENTIONS_HOME = /PATCHWORK_HOME/;

function connectorTests() {
  const out = execFileSync(
    "git",
    ["ls-files", "src/connectors/__tests__/*.test.ts"],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  return out.split("\n").filter(Boolean);
}

let allow;
try {
  const parsed = JSON.parse(readFileSync(path.join(root, ALLOWLIST), "utf8"));
  if (!Array.isArray(parsed.allow)) throw new Error("`allow` must be an array");
  allow = new Set(parsed.allow);
} catch (err) {
  console.error(
    `[connector-test-isolation] ${ALLOWLIST} unreadable: ${err.message}`,
  );
  process.exit(2);
}

const hazards = new Set();

/** Strip block AND line comments — this gate's own rationale, and the notes
 *  left at fixed call sites, both contain the patterns being searched for.
 *  (The first draft of this script flagged its own documentation.) */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

for (const file of connectorTests()) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  const code = stripComments(text);
  // Only the COMBINATION is dangerous: a file that can unlink a credential
  // AND lets PATCHWORK_HOME fall back to the real home while doing it.
  // Unsetting the sandbox in a file that never deletes anything is untidy,
  // not harmful, and forbidding it outright would flag 104 sites for no
  // safety gain.
  if (!DELETES_CREDENTIAL.test(code)) continue;
  if (UNSETS_HOME.test(code) || !MENTIONS_HOME.test(code)) hazards.add(file);
}

const added = [...hazards].filter((f) => !allow.has(f)).sort();
const fixed = [...allow].filter((f) => !hazards.has(f)).sort();

console.log(
  `[connector-test-isolation] ${connectorTests().length} connector test file(s) · ` +
    `${hazards.size} can unlink a credential without a sandbox · ${allow.size} on the ratchet`,
);

let failed = false;

if (added.length > 0) {
  failed = true;
  console.error(
    `\n✗ ${added.length} NEW connector test(s) that can unlink a real credential:\n`,
  );
  for (const f of added) console.error(`  • ${f}`);
  console.error(
    "\nThese call clearTokens()/handle*Disconnect() while PATCHWORK_HOME is unset\n" +
      "or never set. getStorageDir() then falls back to homedir() and the unlink\n" +
      "hits the DEVELOPER'S OWN credential (#1345 — a live Todoist connection).\n" +
      "Sandbox PATCHWORK_HOME for the whole file and restore it rather than\n" +
      "deleting it. Overriding HOME does NOT work: delete process.env.HOME makes\n" +
      `os.homedir() read the passwd entry and return the real home anyway.\n\nDo NOT add the file to ${ALLOWLIST} — that list only shrinks.\n`,
  );
}

if (fixed.length > 0) {
  failed = true;
  console.error(
    `\n✗ ${fixed.length} stale ratchet entr(y/ies) — now isolated:\n`,
  );
  for (const f of fixed) console.error(`  • ${f}`);
  console.error(
    `\nDelete these lines from ${ALLOWLIST}. A ratchet that tolerates stale\n` +
      "entries stops measuring anything.\n",
  );
}

if (failed) process.exit(1);
console.log("[connector-test-isolation] OK — the ratchet holds.");
