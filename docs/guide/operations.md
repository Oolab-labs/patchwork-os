# Operations

Day-two work: putting a build into service, checking that it is the build you think it is, reading the morning summaries, keeping the ledgers, upgrading, and stopping everything in a hurry.

## Deploying a build

There are three states, not two: **merged → installed → running**. A merge is not a deploy, and an install is not a running process. The sequence below moves through all three and checks each step.

From an npm install:

```bash
npm install -g patchwork-os@beta
```

From a repository clone, always from `main`, never from a feature branch:

```bash
git checkout main && git pull
```

```bash
npm run build
```

```bash
npm run install:global
```

`npm run install:global` packs a tarball and installs that. Do **not** use `npm install -g .` on macOS from a checkout under `~/Documents`, `~/Desktop` or `~/Downloads`: npm would create a symlink from the global `node_modules` into the checkout, and macOS privacy protections then stop a launchd-spawned process from following it. The agent appears to install and fails on first load with `EPERM`.

Then restart every running bridge so the running code is the installed code. With the LaunchAgent:

```bash
launchctl kickstart -k gui/$UID/co.patchwork-os.bridge
```

Under systemd on a server, `systemctl restart` the unit instead; under `--watch`, stopping the child is enough. Finally, verify:

```bash
patchwork doctor --expect-running 1
```

```bash
patchwork doctor acceptance
```

Both must exit 0. `doctor` compares each bridge's start time against the installed build's modification time — on purpose not a version string, because a stale process and a fresh one report the same version. Pass `--expect-running N` with the number of bridges you run, because `doctor` cannot see a bridge that failed to start, and without the flag zero bridges is healthy. `doctor acceptance` then exercises the installed package's behaviour (governed policy, a refused write, the kill switch, no resend on uncertain delivery, replay dispatching nothing) in a temporary home, touching none of your data.

A green `doctor` says the running code is the installed code. It does not say the installed code is the merged code; that is what `git pull` and the version in `patchwork --version` are for.

## Health checks

| Command | Question it answers | Gates? |
|---|---|---|
| `patchwork doctor` | Is the running code the installed code, and what is the governance posture? | Yes, exit 1 |
| `patchwork doctor health` | Workspace, git binary, lock file, automation policy present and sane? | Yes, exit 1 |
| `patchwork doctor acceptance` | Does the installed package behave? | Yes, exit 1 |
| `patchwork status` | Is a bridge up, on which port, for how long? | No |
| `patchwork recipe doctor <name>` | Why is this recipe unhealthy and how do I fix it? | Yes, exit 1 |
| `patchwork workers validate` | Does any worker manifest exist but govern nothing? | Yes, exit 1 |
| `patchwork evidence verify` | Is every ledger internally intact? | Yes, exit 1 |
| `patchwork sweep` | What moved since the last sweep? | Only on a gate flipping healthy → unhealthy |

Run `sweep` on a schedule (daily is plenty). It composes the readings above into one counts-only snapshot and diffs it against the previous one, so a number that has not moved in three weeks and a gate that flipped yesterday look different. A first run is a baseline. The drift it reports — evidence ratios, undeclared agent steps — never fails the command, deliberately: wiring those to an exit code would make it permanently red, which is how real warnings get ignored.

## The morning read

```bash
patchwork halts
```

Recent recipe halts by category with the most recent reasons, default window since 6 pm yesterday. A violated `expect` contract shows up here too, even though such a run finishes `done` rather than `error`. `patchwork judgments` does the same for judge-step verdicts. Both take `--window` and `--recipe`.

```bash
patchwork approvals --window overnight
```

What was queued, how long decisions took, how many were abandoned, and whether they came from the dashboard or a phone. To act on one from the terminal, `patchwork approve <callId>` or `patchwork reject <callId>`; the dashboard's inbox does the same with the arguments shown.

If a worker filed something overnight, `patchwork outcomes pending` lists the filings awaiting your confirmation and prints the exact command for each. Confirming is what moves the worker's trust dial; nothing else does.

## Evidence

```bash
patchwork evidence
```

Per ledger, how many rows carry a run id out of how many exist, and how many runs appear in more than one ledger. Counts only, so the output is safe to paste anywhere. It always exits 0.

```bash
patchwork evidence verify
```

Walks the hash chain in every actively written ledger and the markers around rotation and chain start. Exits 1 on a broken chain, a file shorter than its sidecar says it should be, or a write failure that was never sealed. Run it after a restore and whenever you need to show someone the ledgers have not been edited. It prints line numbers and sequence numbers, never a value.

Both read `$PATCHWORK_HOME` (or `--dir`). Neither needs a running bridge.

## Backups

Back up `~/.patchwork` as a directory. It contains your recipes, worker manifests, connector tokens, the roster and every ledger. Two details:

- **Stop the bridge first, or accept a torn tail.** The ledgers are append-only and written under a lock, so a copy taken while a bridge is writing is consistent up to the last complete line. `evidence verify` on the restored copy tells you exactly where it ends.
- **The tokens directory holds live credentials.** Encrypt the backup or exclude `tokens/` and re-authorise connectors on restore.

`patchwork traces export --mode keyed --passphrase <p>` produces an encrypted bundle of the run, decision-trace and commit-link ledgers plus the activity logs; `traces import` restores it. That is a compliance snapshot, not a substitute for backing up the directory.

The bridge's lock files and activity logs under `~/.claude/ide/` are disposable; a bridge recreates them on start.

## Upgrading

Upgrading never changes your profile. An install that was `compat` stays `compat`; opt in with:

```bash
patchwork profile governed
```

and restart the bridge. Before and after any upgrade, `patchwork doctor` shows what is actually enforced. Version-specific steps, including the rename from `claude-ide-bridge` and automation-policy changes, are in [migration.md](../migration.md); the release notes are in [CHANGELOG.md](../../CHANGELOG.md).

Pin an exact version if reproducibility matters. The `canary` channel tracks `main` and can change under you.

## The kill switch

```bash
patchwork panic --reason "why"
```

Blocks every write-tier tool call on every running bridge within about 100 ms: recipe tools, bridge MCP writes, subprocess spawns, the orchestrator. Reads continue and in-flight reasoning is not killed. The reason lands in the audit trail. Check and release with:

```bash
patchwork kill-switch status
```

```bash
patchwork kill-switch release
```

The command exits non-zero if any bridge is unreachable or if the state is frozen by `PATCHWORK_FLAG_KILL_SWITCH_WRITES` in that bridge's environment. Under `governed`, a bridge that cannot read the switch treats it as engaged. Design and alternatives considered: [ADR-0013](../adr/0013-kill-switch.md).

## Running two bridges

Two bridges on one machine is a supported shape — for instance one pinned to a port for OAuth callbacks and the dashboard, and one per editor window. Things to know:

- They share `~/.patchwork`. The ledgers are written under a cross-process lock and both append to the same files; `evidence verify` checks both writers' rows in one chain.
- A scheduled recipe installed on both would fire twice. A cross-process claim store makes one bridge win each tick and the other log that it skipped; `PATCHWORK_CRON_CLAIM_REQUIRED` decides what happens if that store is unwritable (default: fire anyway).
- The kill switch, `doctor` and `kill-switch status` address every live bridge they can find through the lock files.
- `patchwork doctor --expect-running 2` after a restart, so a bridge that did not come back cannot pass as healthy.
- Run identity in the ledgers is the run's `taskId`, not the per-process sequence number; two bridges hand out overlapping sequence numbers.

## Pausing and resuming recipes

```bash
patchwork recipe disable <name>
```

Stops the recipe's cron, file-watch and git-hook triggers without uninstalling it; `recipe enable` reverses it. The dashboard's pause toggle does the same. Note that `on_file_save` and `on_test_run` triggers are registered at bridge startup, so installing a recipe with one of those mid-session needs a restart to take effect.

## When something is wrong

Start with [Troubleshooting](../troubleshooting.md): it opens with five checks that cover most reports. For a recipe, `patchwork recipe doctor <name>` composes lint, policy and recent halts into one screen with a fix hint per finding. For a worker that seems to do nothing, `patchwork workers validate`. For "why was this allowed or gated", `patchwork gate explain <workerId> <classKey>` and `patchwork policy explain <recipe>`.
