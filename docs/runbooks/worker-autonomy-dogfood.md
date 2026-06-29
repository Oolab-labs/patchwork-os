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
- The Test Guardian worker manifest installed at
  `~/.patchwork/workers/test-guardian.worker.yaml` (ships in
  `templates/workers/`).
- The opt-in recipe installed at
  `~/.patchwork/recipes/triage-failing-tests-autofile.yaml` (ships in
  `templates/recipes/`).
- The GitHub connector connected (dashboard `/connections`, or
  `PATCHWORK_GITHUB_*` env). `github.create_issue` needs write scope on the
  target repo.

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
`github.create_issue` step is routed to the human-approval queue every time
*until* the worker has earned (ceiling-capped) L4 on the `issue` class.

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
