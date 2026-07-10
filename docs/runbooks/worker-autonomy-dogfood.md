# Runbook — Live worker-autonomy dogfood (Test Guardian)

**Audience:** the operator (you) running the first *real* delegation.
**Goal:** earn the first genuine trust evidence on the dial by letting the
Test Guardian worker file real triage issues — gated by the ramp on every
filing (the shipped manifest caps `autonomyCeiling` at 1, below the compensable
auto-allow rung, so filing stays gated even after the `issue` class earns L4;
see switch 1).

This is the **weeks-long "does trust accrue?" run**, not the smoke. The smoke
(`src/recipes/__tests__/workerAutonomySmoke.test.ts`) already proves the machine
works end-to-end (gate → execute → persist → attribute) with stubbed Claude +
GitHub. This runbook is for proving the *thesis*: that real operational evidence
moves the dial from L0 toward L4 over time.

> ⚠️ The three switches below file **real GitHub issues** on every failing test
> run once enabled. Read the whole runbook before flipping anything. Order
> matters — see the warning under switch 1.

---

## Preconditions

- A bridge running with the orchestrator driver enabled:
  `patchwork start --driver subprocess` (workers only run under a subprocess/api
  driver — recipes that fire `agent` steps need it). Confirm with
  `patchwork status`.
- The GitHub connector connected (`patchwork connect github`, or the dashboard
  `/connections` page). `github.create_issue` needs `repo` scope on the target
  repo.

> ⚠️ **Local bridges need their OWN GitHub OAuth app.** `patchwork connect
> github` builds the authorize URL from `PATCHWORK_GITHUB_CLIENT_ID` (resolved
> via `~/.patchwork/.secrets.json`, then env). If that points at the shared
> Patchwork app, GitHub rejects the callback with *"The redirect_uri is not
> associated with this application"* — that app only allows its production
> domain, not your `http://localhost:<port>/connections/github/callback`. Fix:
> register a personal OAuth app (GitHub → Settings → Developers → OAuth Apps),
> set its **Authorization callback URL** to exactly
> `http://localhost:<bridge-port>/connections/github/callback`, then put its
> id/secret in `~/.patchwork/.secrets.json`:
> ```json
> { "PATCHWORK_GITHUB_CLIENT_ID": "…", "PATCHWORK_GITHUB_CLIENT_SECRET": "…" }
> ```
> `chmod 600` it and restart the bridge (the secrets file is cached for the
> process lifetime). Then re-run `patchwork connect github` — the URL should now
> carry *your* client id.

### Install the artifacts the bridge actually reads

> ⚠️ **The running bridge does NOT read `templates/`.** It loads recipes from
> `~/.patchwork/recipes/` and worker manifests from `~/.patchwork/workers/`
> (`patchworkConfig.ts`, `runWorkerShadow.ts` `workersDir` default). `templates/`
> in the repo is source only — editing a file there has **zero** effect on a
> running bridge — and **neither artifact is installed for you by default**:
>
> 1. **No init step copies worker manifests.** Nothing seeds
>    `~/.patchwork/workers/`, so the Test Guardian manifest is absent on a fresh
>    setup. Without it there is *no worker* — `loadWorkerTrustForRecipe` returns
>    null and the gate never engages, so the whole ramp is silently inert.
> 2. **`patchwork init` is NOT the recipe scaffolder.** The binary branches on
>    the name you invoke it as (`src/index.ts` — `invokedBinaryName()`):
>    `patchwork init` runs the *IDE-bridge* setup (extension + CLAUDE.md + MCP)
>    and does **not** touch `~/.patchwork/recipes/`. The recipe-scaffolding init
>    is `patchwork-os init` (or the `patchwork-init` subcommand). Even then the
>    autofile recipe is connector-gated, so it only lands with `--with-connectors`.

The reliable, surgical path is to copy both files directly — each is a single
self-contained file, so this sidesteps the init-name footgun entirely. Run from
a checkout of this repo (so `templates/` is your cwd). The commands below carry
no inline `#` comments on purpose — interactive `zsh` does not treat `#` as a
comment, so a trailing `# note` is passed as arguments and breaks the `cp`:

```bash
mkdir -p ~/.patchwork/workers ~/.patchwork/recipes
cp templates/workers/test-guardian.worker.yaml ~/.patchwork/workers/
cp templates/recipes/triage-failing-tests-autofile.yaml ~/.patchwork/recipes/
ls ~/.patchwork/workers/test-guardian.worker.yaml ~/.patchwork/recipes/triage-failing-tests-autofile.yaml
```

Both `ls` paths should print with no error. The base draft-only recipe is
**not** required (you only need it to toggle back later); to install it too:

```bash
cp templates/recipes/triage-failing-tests.yaml ~/.patchwork/recipes/
```

> Bulk alternative: `patchwork-os init --with-connectors` scaffolds
> `~/.patchwork/` and copies all connector recipes (including the autofile one)
> — but note it still does **not** install the worker manifest, so you copy that
> by hand regardless. And it must be `patchwork-os`, not `patchwork`.

All edits in switches 2 + 3 below are made to these **installed** copies under
`~/.patchwork/`, never to `templates/`.

---

## The three switches — IN THIS ORDER

### 1. Enable the `worker.autonomy` feature flag FIRST

Two ways (there is no `patchwork flags` subcommand — the flag is read at bridge
startup from env, then `~/.patchwork/config/flags.json`):

```bash
# Option A — env var (read dynamically on each flag check; simplest for a
# supervised run). Note: unlike the kill-switch flags this one is NOT frozen at
# startup, so the env var must be present in the bridge's environment.
PATCHWORK_FLAG_WORKER_AUTONOMY=1 patchwork start --driver subprocess

# Option B — persisted config file (survives restarts; hot-reloaded by the
# bridge's flag-file watcher, so a restart is optional)
mkdir -p ~/.patchwork/config
echo '{ "worker.autonomy": true }' > ~/.patchwork/config/flags.json
```

This is the switch that **adds the gate**. With it ON, the
`github.create_issue` step is routed to the human-approval queue every time.
The shipped `test-guardian.worker.yaml` caps `autonomyCeiling` at `1` — below
the compensable auto-allow threshold (L2) — so filing stays gated for human
approval even after the worker earns L4 on the `issue` class, until the
outcome-verification signal (confirmed/junk labelling) has a real-world
recall/false-negative track record. Raise the ceiling manually once that
signal exists.

> ⚠️ **Why first.** The flag does NOT enable filing — switches 2+3 do. With the
> flag OFF, an automated `on_test_run` run is **not gated**, so pointing the
> worker at the autofile recipe (switch 2) while the flag is off would file a
> real issue on **every** failing test run with **no approval**. Enable the flag
> first so the very first filing is gated. (Expect more approval prompts up
> front; the shipped ceiling=1 keeps filing gated even at earned L4 —
> autonomous filing is unlocked only by manually raising the ceiling once the
> outcome-verification signal is validated.)

### 2. Point the worker at the autofile recipe

Edit `~/.patchwork/workers/test-guardian.worker.yaml`:

```yaml
# recipe: triage-failing-tests          # ← draft-to-file only (default, safe)
recipe: triage-failing-tests-autofile   # ← the real, issue-filing variant
```

The base recipe writes a triage note to `~/.patchwork/inbox/` and stops — the
risky work is hidden inside the `agent` step, invisible to the ramp. The
autofile variant adds an explicit `github.create_issue` step: an owned,
compensable, brand-exposed action. **That explicit step is the only thing that
moves the dial.**

### 3. Set the target repo

Edit `trigger.vars.repo` in
`~/.patchwork/recipes/triage-failing-tests-autofile.yaml`:

```yaml
trigger:
  vars:
    - name: repo
      default: "your-org/your-repo"     # ← the repo issues are filed against
```

An empty `repo` makes `github.create_issue` fail (and the worker records a
*failure* — don't leave it blank).

Restart the bridge (or re-fire) so the recipe/worker changes are picked up.

---

## What now happens on a failing test run

> ⚠️ **The trigger only sees tests run *through the bridge*.** `on_test_run`
> fires from the bridge's `runTests` tool (`src/tools/runTests.ts`) — i.e. when
> an agent (or you) invokes `runTests`, or a VS Code task wired through it.
> `npm test` now routes through this automatically: `scripts/test-via-bridge.mjs`
> checks for a live bridge lock and calls `runTests` over the `/mcp` HTTP
> endpoint when one is running, so a plain `npm test` from a terminal fires
> `on_test_run` just like an agent-invoked run. With no bridge running (CI,
> or no session attached) it transparently falls back to `vitest run` — same
> behavior as before, no event fires. Use `npm run test:raw` to force the
> direct-vitest path even with a bridge attached.

1. `runTests` fails → the `on_test_run` (filter: failure) trigger fires the
   recipe automatically.
2. `git.log_since` (reversible) → `agent` triage (the `agent` step itself flows)
   → `file.write` the note (reversible) all run **un-gated**.
3. `github.create_issue` (compensable + unearned) is **queued for your
   approval**. Approve it from the dashboard `/approvals` (or the phone path).
4. On approve, the issue is filed and the run is logged to
   `~/.patchwork/runs.jsonl` with the `github.create_issue` step recorded — this
   is the evidence the ramp replays.

Each approved, successful filing is one clean observation on the `issue` class.
Reversibility-scoped gating means routine reversible work never prompts you;
only the risky filing does — and only until trust is earned.

---

## How to watch it

### CLI — the trust dial (read-only)

```bash
patchwork workers shadow
```

Replays `~/.patchwork/runs.jsonl` (dial evidence) + `~/.claude/ide/activity-*.jsonl`
(the live gate's approval decisions) through the (worker × action-class) ramp.
Shows, per class:

- the earned **level** (L0–L4) and observation count,
- the **ramp-would-X / gate-did-Y** divergence line.

Watch the `issue` row climb as clean filings accumulate. Run it each morning.

### Dashboard — the dial UI

Open the dashboard **`/workers`** page. The Test Guardian card shows the same
per-class dial with the trust curve. The `/approvals` page is where you sign off
each gated filing; `/runs` shows each fired run and its step verdicts.

---

## What "success" looks like (and the honest caveat)

- **Short term (the afternoon):** a failing test → a gated approval prompt →
  one issue filed → one observation on the `issue` row. The machine works.
- **Long term (weeks):** the `issue` row climbs L0 → … → L4 on a slow, clean
  evidence ramp. A single failed/rejected filing demotes it hard and you re-earn
  from an elevated β. **This latency is the point** — trust is an *output* earned
  from real evidence, not an input you grant. The competence prior
  (`mean: 0.8, strength: 4` in the manifest) accelerates the honest path to
  ~days, not weeks, without faking evidence.
- When `issue` reaches L4, the *earned* level is maxed — but the shipped
  manifest caps `autonomyCeiling` at 1, so the gate keeps prompting on every
  filing. Autonomous filing (the first responsibility genuinely delegated)
  requires manually raising the ceiling to ≥2 once the outcome-verification
  signal has a real-world track record.

### Rollback

Flip any switch back:
- `recipe: triage-failing-tests` (worker manifest) → stops filing, back to
  draft-to-file;
- remove `PATCHWORK_FLAG_WORKER_AUTONOMY` / set `"worker.autonomy": false` in
  `~/.patchwork/config/flags.json` and restart → gate disengages entirely
  (⚠️ leaves switches 2+3 filing **un-gated** — disable the flag only together
  with reverting switch 2);
- `patchwork recipe disable triage-failing-tests-autofile` → stops the trigger
  firing at all (cleanest full stop).

---

## Closing the trust loop — confirming filings

**A filed issue does NOT move the dial on its own.** Past the 24h durability
window the trust ramp reads the issue's *outcome disposition*: `confirmed` earns
trust (`good:true`), `junk` lowers it, and `unknown` (nobody acted on it) is
**withheld — not counted at all** (an unactioned filing must not earn trust by
sitting unopened). So after you approve a filing, you still have to tell the
system whether it was real. There are two ways, and **neither can be done by the
worker itself** — the reward path is as independent of the worker as the penalty
path:

1. **On GitHub (feeds the ingester).** Close the issue as *completed* (GitHub's
   default close) → `confirmed`; close as *not planned* or label it
   `invalid`/`duplicate`/`wontfix` → `junk`; or apply a `patchwork:valid` /
   `confirmed` / `verified` label → `confirmed`. The **outcome-ingester** recipe
   (`templates/recipes/outcome-ingester.yaml`, cron every 6h) polls issues by
   its `label` var and writes the disposition to `~/.patchwork/outcome-log.jsonl`.
   > ⚠️ Install `outcome-ingester.yaml` into `~/.patchwork/recipes/` too, and set
   > its `repo` var to the **same** `owner/repo` the autofile recipe files
   > against. A blank `repo` makes its search qualifier malformed and it records
   > nothing.

2. **Locally, no GitHub round-trip (the direct path):**
   ```bash
   patchwork outcomes confirm <issue-url>    # the filing was real  → confirmed
   patchwork outcomes reject  <issue-url>    # the filing was noise → junk
   patchwork outcomes list                   # what's been recorded so far
   ```
   This writes straight to `~/.patchwork/outcome-log.jsonl` — the same store the
   ramp reads. Pass the issue URL exactly as the worker filed it.

Either way, the `issue` dial only climbs on **confirmed** dispositions. Watch it
with `patchwork workers shadow`.

### Cycle log

- **2026-07-08 — synthetic failure, reject disposition (as designed).** Planted
  a synthetic test failure to exercise the full loop end-to-end. `runTests`
  failed → `on_test_run` fired → the gate correctly held `github.create_issue`
  at L0 for `issue:compensable:high` → operator approved the gated filing →
  issue #1143 was filed → operator ran `patchwork outcomes reject
  <issue-#1143-url>` (correct call: the underlying failure was synthetic, not a
  real bug) → `patchwork workers shadow` confirmed the `issue` dial stayed
  unmoved at L0 (5 observations, 21%). Issue #1143 closed on GitHub. This
  validates the "unknown/rejected disposition must not silently earn trust"
  fix — a `reject` disposition correctly does not move the dial upward.
- **2026-07-10 — release-notes-worker reviewed, made dogfood-ready (not yet
  run live).** `templates/workers/release-notes.worker.yaml` +
  `templates/recipes/release-notes.yaml` had zero `worker_gate_decisions.jsonl`
  / `outcome-log.jsonl` entries — never exercised end-to-end. Verified: `recipe
  lint` and `recipe preflight` both pass clean; `npm run build` clean;
  `loadWorkersFromDir` loads the manifest with no parse errors; `owns:
  [vcs-read, fs-write]` matches `DOMAIN_BY_TOOL` domains in
  `src/workers/actionClass.ts` exactly (no drift); the `git_hook`/`post-commit`
  trigger compiles to `onGitCommit` (`src/recipes/compiler.ts`), the same
  bridge-tool-fired hook pattern Test Guardian's `on_test_run` uses — i.e. it
  only fires on commits made via the bridge's `gitCommit` tool, not bare `git
  commit`. No code changes were needed; nothing was broken. Not yet dogfooded:
  the recipe still needs `patchwork recipe install` (or a manual copy) into
  `~/.patchwork/recipes/`, and the worker manifest into
  `~/.patchwork/workers/`, before a real commit will exercise the `vcs-read` /
  `fs-write` gate for the first time.
- **2026-07-10 (later same day) — release-notes-worker actually fired; two
  correction items found by a multi-agent dogfood-setup review.** Corrected
  the entry immediately above: the worker WAS installed and fired for real
  later the same day — the Decision Record's last entries show
  `workerId=release-notes-worker`, `action=allow`, `earnedLevel=0`,
  `autonomyCeiling=4`, covering `agent`/`file.write`/`git.log_since`. All
  trivially `allow` (its classes are reversible, so this produced zero real
  ramp signal), but "not yet run live" as of this correction is false — worth
  noting here since the previous entry is easy to misread as still current.
  The same review surfaced two real bugs, both fixed:
  1. **Outcome-store trust-by-overwrite.** `outcome-log.jsonl`'s last
     recorded disposition for issue #1143 (the synthetic-failure test above)
     had flipped from `junk` back to `confirmed`, authored by
     `outcome-ingester` — the automated cron silently overwrote the manual
     `outcomes reject` from 2026-07-08, because `OutcomeRecord` had no field
     distinguishing a human's explicit judgment from an automated poll and
     the store was pure last-writer-wins. Fixed: `OutcomeRecord.origin`
     (`"manual" | "ingester"`), and a manual disposition is now sticky
     against a later ingester overwrite (a later *manual* write still
     applies normally — the operator can change their own mind).
     `patchwork outcomes reject <issue-#1143-url>` should be re-run to
     restore the correct disposition on disk (the code fix only prevents
     *future* overwrites, it doesn't retroactively undo this one).
  2. **`owns[]` drift on all three worker manifests**, found by cross-
     checking each recipe's actual steps against `DOMAIN_BY_TOOL`:
     Test Guardian was missing `fs-write` (its `write_note`/`file.write`
     step) and claimed `ci` (nothing in the recipe body maps to that
     domain — the `on_test_run` trigger firing externally doesn't count).
     Dependency Upkeep claimed `vcs-remote`/`deps-read`/`vcs-local` — none
     ever exercised, since `dependency-bump.yaml` only reviews existing PRs,
     it never opens one — while missing `vcs-read` (`github.list_prs`).
     Also found: `release-notes.yaml`, `triage-failing-tests.yaml`, and
     `dependency-bump.yaml` were all missing `allowWrites` for their
     `file.write` step, failing `recipe preflight` out of the box (the
     *installed* copy of release-notes.yaml had the fix; the tracked
     template didn't — now synced). All three worker manifests and all
     three recipe templates corrected; `src/workers/__tests__/
     runWorkerShadow.test.ts` updated to match (two tests were asserting
     the pre-fix, incorrect ownership).

### Raising the ceiling

The shipped Test Guardian manifest caps `autonomyCeiling` at `1`, below the
compensable auto-allow rung (L2) — so even at earned L4, filing stays gated for
human approval. Once you have a real-world track record (a run of confirmed
clean filings with a low false-negative rate — say ~10–20 confirmed and no
confirmed-but-actually-junk cases), raise it by editing the **installed** copy
`~/.patchwork/workers/test-guardian.worker.yaml` (never `templates/` — the
running bridge reads `~/.patchwork/`): set `autonomyCeiling: 2` (the minimum
that unlocks compensable auto-allow at effective L2), then reload/restart the
bridge. Drop it back to `1` to re-gate immediately.

---

## What's next

- **Dogfood a real failure, not a synthetic one.** The 2026-07-08 cycle
  exercised gate → approve → file → **reject** end-to-end but, by design,
  never moved the dial (a synthetic failure is correctly noise). The dial has
  never been observed moving upward. The next cycle needs a genuine test
  failure so a `patchwork outcomes confirm <issue-url>` disposition can be
  exercised and trust accrual on `issue:compensable:high` can be verified for
  the first time, not just its absence.
- **Only one action-class has been dogfooded.** Everything to date covers
  `issue:compensable:high` via the Test Guardian worker. Other action-classes
  (e.g. other compensable or irreversible classes on other workers/recipes)
  have not been run through this loop at all — trust-dial behavior there is
  unverified.
