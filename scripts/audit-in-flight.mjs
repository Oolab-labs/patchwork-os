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
import { existsSync, readFileSync } from "node:fs";
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

/**
 * `feat/thing`, `fix/other-thing` — the format the Convention section asks for.
 *
 * The previous pattern was `[a-z][a-z0-9]*\/[a-z0-9][a-z0-9._-]*`, which was
 * wrong in BOTH directions at once:
 *
 *   - Too narrow for branches. It stopped at the second slash and rejected
 *     uppercase and underscores, so `feat/foo/bar` and `fix/ADR-20_thing` were
 *     invisible — and an entry the gate cannot see is an entry it silently does
 *     not verify, which is this gate's whole failure history.
 *   - Too wide for prose. Entries name the files they touch in backticks, and
 *     `src/server.ts` matches the branch shape exactly. Observed live on
 *     2026-08-16: an Active section with ONE entry reported "3 branch(es)
 *     checked" — the entry's branch plus `src/server.ts` and `src/bridge.ts`.
 *     They passed only because a nonexistent branch has no PR, and "no PR yet"
 *     is deliberately treated as fine. The count a human reads was inflated by
 *     things that are not branches.
 *
 * So the pattern widens, and a second test disambiguates: a token that EXISTS
 * ON DISK is a file path, not a branch. Deliberately not an extension
 * blocklist — `.ts`/`.mjs` is a guess about spelling, whereas existence is the
 * actual question, and branches legitimately contain dots (`release/1.2.x`).
 * What is excluded is printed, because a token silently dropped by a gate is
 * indistinguishable from one it checked and passed.
 */
const BRANCH_RE = /`([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+)`/g;

/**
 * True when the token names something that exists in the repo — i.e. a path.
 *
 * Resolved against `root` (this script's own location), never `cwd`, so the
 * test means the same thing however the gate is invoked.
 */
function looksLikeRepoPath(token) {
  return existsSync(path.join(root, token));
}

/**
 * Ledger path. `--ledger <path>` exists so the fail-closed behaviour can be
 * tested against a fixture instead of the live file — a test that depends on
 * whatever happens to be in Active today is a test that stops running the day
 * the section is empty, which is precisely the silent-skip failure this gate
 * is about.
 */
function ledgerPath() {
  const i = process.argv.indexOf("--ledger");
  return i !== -1 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.join(root, LEDGER);
}

function activeSection() {
  let text;
  try {
    text = readFileSync(ledgerPath(), "utf8");
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
    // Probe the REPO, not `/user`.
    //
    // `gh api user` was the probe, and it made this gate skip itself in CI —
    // the precise failure the note above says it was written to avoid, so the
    // note was true and the code did not implement it. Actions' GITHUB_TOKEN
    // is a repo-scoped installation token: it can read the repo and list PRs,
    // but `GET /user` returns 403 "Resource not accessible by integration"
    // because an installation has no user. `canQuery` therefore returned false
    // for BOTH candidate environments and the gate printed
    // "SKIPPED — gh is unavailable or unauthenticated" on every CI run.
    //
    // Verified from a real CI log (run 31873349778) before changing anything:
    // two Active entries went unverified on a run that reported green, one of
    // them naming a branch whose PR had already merged — exactly what this
    // gate exists to catch.
    //
    // The repo endpoint is the right probe because it is what the gate
    // actually needs: `prState` calls `gh pr list`, which is a repo read. A
    // probe that tests a capability the tool never uses can fail while every
    // real call would have succeeded.
    execFileSync("gh", ["api", "repos/{owner}/{repo}", "--jq", ".full_name"], {
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

/**
 * `MERGED` | `CLOSED` | `OPEN` | null when no PR exists for the branch.
 *
 * THROWS when `gh` itself fails, and that distinction is the whole point.
 * This used to `catch { return null }`, which made "gh could not reach the
 * API" indistinguishable from "this branch has no PR yet" — and the second
 * is explicitly treated as fine, because that is what a branch looks like
 * before its PR exists. So a network blip turned every stale entry clean.
 *
 * Observed, not theorised: two runs seconds apart on the same tree, one
 * reporting `OK — every Active entry is genuinely in flight` and the other
 * correctly failing on a merged entry. A gate whose verdict depends on the
 * network is not a gate.
 *
 * Retried before giving up, for the same reason the CVE gate is (#1413):
 * this is a read-only query, so retrying has no side effects, and failing
 * the build on one bad second would just be a new flake.
 */
function prStateOrThrow(branch) {
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
}

/** `prStateOrThrow` with backoff. Exits 2 when `gh` never answers. */
function prState(branch) {
  const DELAYS_MS = [0, 2000, 6000];
  let last;
  for (let attempt = 0; attempt < DELAYS_MS.length; attempt++) {
    if (DELAYS_MS[attempt] > 0) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        DELAYS_MS[attempt],
      );
    }
    try {
      return prStateOrThrow(branch);
    } catch (err) {
      last = err;
      if (attempt < DELAYS_MS.length - 1) {
        console.warn(`[in-flight] ${branch}: gh query failed — retrying`);
      }
    }
  }
  // Exit 2 (script/config error), never 0: "we could not check" is a
  // different fact from "we checked and it was fine".
  console.error(
    `\n[in-flight] FAIL — could not query PR state for ${branch}: ${last?.message ?? "unknown error"}\n\n` +
      "  This is a hard failure on purpose. Reporting a clean ledger because\n" +
      "  the API was unreachable is how an entry for merged work survives.\n",
  );
  process.exit(2);
}

function main() {
  const section = activeSection();
  const branches = new Map();
  const excludedPaths = new Set();
  for (const { line, n } of section) {
    if (!line.trim().startsWith("- ")) continue;
    for (const m of line.matchAll(BRANCH_RE)) {
      const token = m[1];
      // Entries name the files they touch in backticks, and a file path is
      // shaped exactly like a branch. Existence is what separates them.
      if (looksLikeRepoPath(token)) {
        excludedPaths.add(token);
        continue;
      }
      if (!branches.has(token)) branches.set(token, n);
    }
  }
  // Printed, not silent. A gate that drops tokens without saying so reports a
  // count nobody can reconcile with the ledger they are reading.
  if (excludedPaths.size > 0) {
    console.log(
      `[in-flight] ignored ${excludedPaths.size} backticked path(s) that exist in the repo: ${[
        ...excludedPaths,
      ].join(", ")}`,
    );
  }

  if (branches.size === 0) {
    console.log(
      "[in-flight] Active section names no branches — nothing to check.",
    );
    process.exit(0);
  }

  if (!ghAvailable()) {
    const n = branches.size;
    const entries = `${n} Active entr${n === 1 ? "y" : "ies"}`;
    // Skipping is tolerable on a laptop with no `gh` — blocking a developer
    // who never asked for this check is worse than one unverified ledger.
    //
    // In CI it is NOT tolerable, and treating the two the same is how this
    // gate spent its whole life green without checking anything. CI is the one
    // place the credential is guaranteed present, so "cannot query" there
    // means the probe or the token is broken, not that the check is optional.
    // A gate that announces it did nothing, in the one environment that
    // enforces it, is indistinguishable from a passing gate to everyone
    // reading the check list.
    if (process.env.CI) {
      console.error(
        `\n[in-flight] FAIL — gh is unavailable or unauthenticated in CI, so ` +
          `${entries} could not be verified.\n\n` +
          `  This gate is only meaningful when it can query PR state. Skipping ` +
          `here would\n  report green while checking nothing, which is how the ` +
          `"gh api user" probe\n  went unnoticed: an installation token cannot ` +
          `read /user, so every CI run\n  skipped itself.\n\n` +
          `  Fix the credential or the probe — do not make this branch exit 0.\n`,
      );
      process.exit(1);
    }
    console.log(
      `[in-flight] SKIPPED — gh is unavailable or unauthenticated. ` +
        `${entries} not verified. (Would FAIL in CI.)`,
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
