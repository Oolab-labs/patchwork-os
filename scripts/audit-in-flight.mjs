/**
 * In-flight ledger gate.
 *
 * Fails when `docs/in-flight.md`'s **Active** section names a branch whose
 * pull request is already merged or closed.
 *
 * ## Why this exists
 *
 * The ledger was created after two sessions independently built the same fix
 * without knowing about each other. CLAUDE.md tells every session to read it
 * before starting non-trivial work, which makes it the highest-trust document
 * in the repository for that one question.
 *
 * It has been swept by hand twice — most recently on 2026-08-03 — and decayed
 * both times. On 2026-08-08 all ten distinct Active entries were merged, the
 * oldest four days earlier, several listed twice by the union-merge driver.
 * So the document built to stop sessions colliding was handing them stale
 * state, and a session acting on it would either duplicate finished work or
 * avoid touching a subsystem nobody was in.
 *
 * Three manual sweeps is enough evidence that "remove your line when the PR
 * merges" does not survive contact with a busy day. The convention is fine;
 * relying on memory to enforce it is not.
 *
 * ## What it checks
 *
 * Only the Active section, and only entries naming a branch in backticks.
 * An entry whose branch has a merged or closed PR is drift. An entry with no
 * PR at all is fine — that is exactly what "I am working on this right now"
 * looks like before the PR exists.
 *
 * ## Why merge state and not branch existence
 *
 * This repo squash-merges and deletes branches, so `git branch -r` lists ~130
 * branches including demonstrably merged ones — it cannot answer the question.
 * PR state can, which is why this shells out to `gh`.
 *
 * ## A stale GITHUB_TOKEN must not silently disable this
 *
 * This repo's working notes say to run `env -u GITHUB_TOKEN gh …` because an
 * exported-but-stale GITHUB_TOKEN makes every `gh` call 401. The first version
 * of this script inherited it, `gh auth status` failed, and the gate SKIPPED —
 * reporting success while checking nothing, which is precisely the failure it
 * was written to catch. `gh` is therefore invoked with GITHUB_TOKEN removed,
 * so it falls back to the keyring credentials that work.
 *
 * ## Offline and unauthenticated runs
 *
 * If `gh` is missing or not authenticated, this SKIPS rather than fails. A
 * documentation-hygiene gate must not be the reason a contributor without a
 * GitHub token cannot run the audits, and CI always has one. The skip is
 * printed, not silent — a check that quietly does nothing is the failure mode
 * this whole script exists to correct.
 *
 * Usage:  node scripts/audit-in-flight.mjs
 * Exit:   0 clean or skipped · 1 stale entries · 2 script error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const LEDGER = "docs/in-flight.md";

/**
 * Environment for `gh`, resolved once.
 *
 * Two opposite hazards, which is why this is not a constant:
 *
 *   - LOCALLY, a stale exported GITHUB_TOKEN 401s every call. The repo's own
 *     working notes say to run `env -u GITHUB_TOKEN gh …` for exactly this.
 *   - IN CI, GITHUB_TOKEN is the ONLY credential there is. Stripping it
 *     unconditionally — the first version of this file did — would make the
 *     gate skip itself in the one place it is meant to run.
 *
 * So: try the inherited environment, and fall back to one without the token
 * only if that fails. Whichever authenticates is the one used.
 */
const withoutToken = (() => {
  const { GITHUB_TOKEN, GH_TOKEN, ...rest } = process.env;
  return rest;
})();

let GH_ENV = process.env;

/** `feat/thing`, `fix/other-thing` — the format the Convention section asks for. */
const BRANCH_RE = /`([a-z][a-z0-9]*\/[a-z0-9][a-z0-9._-]*)`/g;

function activeSection() {
  let text;
  try {
    text = readFileSync(path.join(root, LEDGER), "utf8");
  } catch (err) {
    console.error(`[in-flight] cannot read ${LEDGER}: ${err.message}`);
    process.exit(2);
  }
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Active");
  if (start === -1) {
    console.error(`[in-flight] ${LEDGER} has no "## Active" heading`);
    process.exit(2);
  }
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => l.startsWith("## "));
  return (endRel === -1 ? rest : rest.slice(0, endRel)).map((line, i) => ({
    line,
    n: start + 2 + i,
  }));
}

/**
 * Can we actually query GitHub?
 *
 * NOT `gh auth status` — it exits non-zero when ANY configured account fails
 * to log in, even while the active one works fine. On the machine this was
 * written on, one of three stored accounts is stale, so that probe reported
 * "unauthenticated" and the gate skipped itself into a no-op. `gh api user`
 * tests the thing that matters: whether an authenticated call succeeds.
 */
function canQuery(env) {
  try {
    execFileSync("gh", ["api", "user", "--jq", ".login"], {
      stdio: "ignore",
      env,
    });
    return true;
  } catch {
    return false;
  }
}

function ghAvailable() {
  if (canQuery(process.env)) {
    GH_ENV = process.env;
    return true;
  }
  if (canQuery(withoutToken)) {
    GH_ENV = withoutToken;
    return true;
  }
  return false;
}

/** `MERGED` | `CLOSED` | `OPEN` | null when no PR exists for the branch. */
function prState(branch) {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,state",
        "--jq",
        '.[0] | "\\(.number) \\(.state)"',
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: GH_ENV,
      },
    ).trim();
    if (!out || out === "null null") return null;
    const [number, state] = out.split(" ");
    return { number, state };
  } catch {
    return null;
  }
}

function main() {
  const section = activeSection();
  const branches = new Map();
  for (const { line, n } of section) {
    if (!line.trim().startsWith("- ")) continue;
    for (const m of line.matchAll(BRANCH_RE)) {
      if (!branches.has(m[1])) branches.set(m[1], n);
    }
  }

  if (branches.size === 0) {
    console.log(
      "[in-flight] Active section names no branches — nothing to check.",
    );
    process.exit(0);
  }

  if (!ghAvailable()) {
    console.log(
      `[in-flight] SKIPPED — gh is unavailable or unauthenticated. ` +
        `${branches.size} Active entr${branches.size === 1 ? "y" : "ies"} not verified.`,
    );
    process.exit(0);
  }

  const stale = [];
  for (const [branch, n] of branches) {
    const pr = prState(branch);
    if (pr && pr.state !== "OPEN") {
      stale.push({ branch, n, ...pr });
    }
  }

  console.log(
    `[in-flight] ${branches.size} branch(es) named in the Active section checked.`,
  );

  if (stale.length === 0) {
    console.log("[in-flight] OK — every Active entry is genuinely in flight.");
    process.exit(0);
  }

  console.error(`\n[in-flight] FAIL — ${stale.length} finished entr(y/ies):\n`);
  for (const s of stale) {
    console.error(
      `  ${LEDGER}:${s.n}  ${s.branch} — PR #${s.number} ${s.state}`,
    );
  }
  console.error(
    `\nMove them to "Recently closed", or delete them. CLAUDE.md tells every\n` +
      `session to read the Active section before starting work, so an entry\n` +
      `left here after its PR merges is worse than no ledger: it is a claim\n` +
      `that somebody is working on something nobody is working on.\n`,
  );
  process.exit(1);
}

main();
