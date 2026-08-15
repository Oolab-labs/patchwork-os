#!/usr/bin/env node
/**
 * Private-identifier gate — the mechanical half of CLAUDE.md's Repository
 * Privacy section.
 *
 * ## Why this exists
 *
 * That section is the highest-stakes rule in the repo and, until now, it was
 * enforced entirely by remembering:
 *
 *   > Before every commit, push and PR, read the diff, the commit text and
 *   > the branch name yourself.
 *
 * Nothing checked. `audit-business-content` reads TRACKED MARKDOWN only
 * (`git ls-files "*.md"`) and looks for commercial content — it never sees
 * code, tests, fixtures, commit messages or branch names, and its own header
 * says it "cannot recognise a real third-party name used as a neutral-looking
 * identifier".
 *
 * Conventions that depend on remembering do not hold here. The in-flight
 * ledger decayed three times and needed a gate; that gate then spent its whole
 * life skipping itself in CI; and its author forgot to retire an entry twice
 * in the session that fixed it. This is the same class of rule with far worse
 * consequences, because a public commit cannot be withdrawn.
 *
 * ## The denylist never enters the repository
 *
 * That is the entire design constraint. The forbidden strings are exactly what
 * must not be published, so they cannot live in a tracked file, and this
 * script must never print a matched string back — only the fact of a match and
 * where it was.
 *
 * Resolution order:
 *   1. `$PATCHWORK_DENYLIST`                    — explicit path
 *   2. `~/.patchwork/private-identifiers.txt`   — OUTSIDE the repo, so it
 *                                                 cannot be committed even by
 *                                                 `git add -f`. Preferred.
 *   3. `<repo>/.private-denylist`               — gitignored convenience
 *
 * One pattern per line. `#` comments and blank lines ignored. Matching is
 * case-insensitive substring — the threat is a real name used as a
 * neutral-looking identifier, which no clever regex improves on.
 *
 * ## What it checks
 *
 * The three things CLAUDE.md names as the ones people forget:
 *   - the staged diff (code, tests, fixtures — not just markdown)
 *   - the commit message
 *   - the branch name
 *
 * Usage:
 *   node scripts/audit-private-identifiers.mjs                 # staged diff + branch
 *   node scripts/audit-private-identifiers.mjs --message FILE  # commit message
 *   node scripts/audit-private-identifiers.mjs --text FILE     # arbitrary file
 *
 * Exit: 0 clean · 1 match found · 2 script/config error
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DENYLIST = ".private-denylist";

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Refuse to run if the denylist has been committed.
 *
 * This is the worst possible outcome of the whole design — a tracked denylist
 * publishes verbatim the exact strings it exists to keep out, in a file
 * helpfully labelled as the list of things that must stay secret. Checked
 * FIRST, and it is a hard error rather than a warning.
 */
function assertDenylistNotTracked() {
  let tracked = "";
  try {
    tracked = git(["ls-files", REPO_DENYLIST]).trim();
  } catch {
    return; // not a git repo / git unavailable — other paths report that
  }
  if (tracked) {
    console.error(
      `\n[private-ids] FATAL — ${REPO_DENYLIST} is TRACKED by git.\n\n` +
        `  That file lists the strings that must never be published, so committing\n` +
        `  it publishes all of them at once, clearly labelled. Remove it from the\n` +
        `  index before doing anything else:\n\n` +
        `      git rm --cached ${REPO_DENYLIST}\n\n` +
        `  and confirm ${REPO_DENYLIST} is in .gitignore. If it has already been\n` +
        `  pushed, treat it as a disclosure, not a mistake to quietly undo.\n`,
    );
    process.exit(2);
  }
}

/** Where the denylist lives, or null. */
function resolveDenylistPath() {
  const explicit = process.env.PATCHWORK_DENYLIST;
  if (explicit?.trim()) return explicit.trim();
  const home = path.join(homedir(), ".patchwork", "private-identifiers.txt");
  if (existsSync(home)) return home;
  const local = path.join(root, REPO_DENYLIST);
  if (existsSync(local)) return local;
  return null;
}

function loadPatterns(p) {
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    console.error(`[private-ids] cannot read ${p}: ${err.message}`);
    process.exit(2);
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Sources to scan: `{ label, text }`. */
function collectSources(argv) {
  const msgIdx = argv.indexOf("--message");
  if (msgIdx !== -1) {
    const f = argv[msgIdx + 1];
    if (!f) {
      console.error("[private-ids] --message requires a file path");
      process.exit(2);
    }
    return [{ label: `commit message (${path.basename(f)})`, text: read(f) }];
  }
  const txtIdx = argv.indexOf("--text");
  if (txtIdx !== -1) {
    const f = argv[txtIdx + 1];
    if (!f) {
      console.error("[private-ids] --text requires a file path");
      process.exit(2);
    }
    return [{ label: f, text: read(f) }];
  }

  const sources = [];
  // The STAGED diff, not the working tree: this is what is about to become a
  // commit. Includes code, tests and fixtures — the places
  // `audit-business-content` structurally cannot look.
  try {
    sources.push({ label: "staged diff", text: git(["diff", "--cached"]) });
  } catch {
    /* no git / no staged changes */
  }
  try {
    sources.push({
      label: "branch name",
      text: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    });
  } catch {
    /* detached / no repo */
  }
  return sources;
}

function read(f) {
  try {
    return readFileSync(f, "utf8");
  } catch (err) {
    console.error(`[private-ids] cannot read ${f}: ${err.message}`);
    process.exit(2);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

assertDenylistNotTracked();

const denylistPath = resolveDenylistPath();
if (!denylistPath) {
  // LOUD, and explicit that nothing was verified.
  //
  // Exiting 0 silently is precisely how `audit-in-flight` reported green while
  // checking nothing for its entire life. A developer who has not configured a
  // denylist should not be blocked from committing — but they must not be able
  // to read this as "the check passed" either.
  console.warn(
    `\n[private-ids] NOT CONFIGURED — this check verified NOTHING.\n\n` +
      `  CLAUDE.md's Repository Privacy section is enforced by hand without it.\n` +
      `  Create one (never inside the repo — it is the list of secrets):\n\n` +
      `      mkdir -p ~/.patchwork\n` +
      `      $EDITOR ~/.patchwork/private-identifiers.txt   # one string per line\n\n` +
      `  Set PATCHWORK_DENYLIST_REQUIRED=1 to make this state a hard failure.\n`,
  );
  process.exit(process.env.PATCHWORK_DENYLIST_REQUIRED === "1" ? 1 : 0);
}

const patterns = loadPatterns(denylistPath);
if (patterns.length === 0) {
  // A file with no patterns scans everything against nothing and reports
  // clean. Same hazard as a scan that walks zero files.
  console.warn(
    `\n[private-ids] EMPTY DENYLIST at ${denylistPath} — this check verified NOTHING.\n`,
  );
  process.exit(process.env.PATCHWORK_DENYLIST_REQUIRED === "1" ? 1 : 0);
}

const sources = collectSources(process.argv.slice(2));
const lowered = patterns.map((p) => p.toLowerCase());
const hits = [];
let scannedBytes = 0;

for (const { label, text } of sources) {
  if (!text) continue;
  scannedBytes += text.length;
  const hay = text.toLowerCase();
  for (let i = 0; i < lowered.length; i++) {
    if (hay.includes(lowered[i])) {
      // Report the INDEX, never the string. Printing the match would write the
      // secret into terminal scrollback, CI logs and screenshots — the same
      // mistake one layer over.
      hits.push({ label, index: i + 1 });
    }
  }
}

if (hits.length > 0) {
  console.error(
    `\n[private-ids] BLOCKED — denylisted identifier found in ${hits.length} place(s):\n`,
  );
  for (const h of hits) {
    console.error(`  ${h.label}  — denylist entry #${h.index}`);
  }
  console.error(
    `\n  The matched text is deliberately NOT printed: echoing it would put the\n` +
      `  secret into scrollback, CI logs and screenshots.\n\n` +
      `  Entry numbers refer to non-comment lines in ${denylistPath}.\n` +
      `  Remove the identifier and re-stage. If it is already pushed, that is a\n` +
      `  disclosure — see CLAUDE.md "Where a sensitive finding goes".\n`,
  );
  process.exit(1);
}

console.log(
  `[private-ids] OK — ${patterns.length} pattern(s) checked against ` +
    `${sources.length} source(s), ${scannedBytes} bytes.`,
);
process.exit(0);
