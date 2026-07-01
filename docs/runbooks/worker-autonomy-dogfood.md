# Runbook — Live worker-autonomy dogfood (Test Guardian)

**Audience:** the operator (you) running the first *real* delegation.
**Goal:** earn the first genuine trust evidence on the dial by letting the
Test Guardian worker file real triage issues — gated by the ramp until it
earns L4 on the `issue` action-class.

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
> front; autonomous filing is the payoff *after* L4 is earned.)

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
> an agent (or you) invokes `runTests`, or a VS Code task wired through it. A
> bare `npm test` / `vitest` in a plain terminal is **invisible** to the worker;
> it produces no `on_test_run` event and nothing fires. To exercise the loop,
> run your suite via `runTests` (e.g. ask Claude to run the tests through the
> bridge), not directly in a shell.

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
- When `issue` reaches L4, the gate stops prompting and filings flow
  autonomously — the first responsibility genuinely delegated.

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
