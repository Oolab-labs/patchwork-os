# CLI reference

The command set below matches `patchwork --help` for the current release. Sections follow the groups that help text uses. `patchwork <command> --help` prints the detail for any command; where a subcommand has flags not shown in the top-level help, they were taken from its own help text.

The `claude-ide-bridge` binary accepts the same commands. Most commands that need a running bridge find it through the lock files in `~/.claude/ide/`; set `PATCHWORK_BRIDGE_URL` or `PATCHWORK_BRIDGE_PORT` to point them elsewhere.

Exit codes follow one convention: a command whose job is to **gate** exits 1 when it finds a problem; a command whose job is to **report** exits 0 whatever it finds, because a true reading is not an error. Each entry below says which.

## Get started

### `init`

```bash
patchwork init [--with-connectors] [--force] [--no-ollama]
```

Scaffolds `~/.patchwork/` (`config.json`, `recipes/`, `inbox/`, `journal/`), copies the local-only recipe templates, detects a local Ollama and sets the provider to it if found, and registers the Patchwork `PreToolUse` hook in `~/.claude/settings.json`. A **new** config is written with `profile: governed`; an existing one is merged and its profile left alone. `--with-connectors` also copies the connector-backed recipes; `--force` overwrites instead of merging.

### `install-extension`

```bash
patchwork install-extension [editor]
```

Installs the companion extension into VS Code, Cursor, Windsurf or Antigravity. With no argument it auto-detects; pass `code`, `cursor`, `windsurf` or `antigravity` to choose.

### `start-all` and `start`

```bash
patchwork start [--workspace <path>] [--no-dashboard] [--dashboard-port <N>] [--slim] [--notify <topic>] [--vps <user@host>]
```

Launches bridge + `claude --ide` + dashboard. `start` is a thin wrapper over `start-all` with the common flags; on macOS and Linux it uses tmux when present, on Windows it runs natively. `--notify` pushes notifications through ntfy; `--vps` opens an SSH reverse tunnel for a stable public URL. Ctrl+C stops everything.

### `orchestrator`

```bash
patchwork orchestrator [--port <N>] [--bind <addr>] [--lock-dir <dir>] [--health-interval <ms>]
```

Starts a meta-bridge that discovers every running bridge and exposes them as one MCP server, so one Claude session can work across several workspaces. Default port 4746.

## Recipes

Run `patchwork recipe --help` for the subcommand index. Recipe names are lowercase letters, digits, `-` and `_`.

| Subcommand | Synopsis | Purpose |
|---|---|---|
| `new` | `recipe new <name> [-i] [--template minimal\|daily\|inbox] [--desc <text>] [--out <dir>]` | Scaffold a recipe. `-i` opens the interactive, connector-aware builder. |
| `list` | `recipe list` | Installed recipes (workspace and user) from the active bridge. |
| `run` | `recipe run <name-or-file> [--local] [--dry-run] [--step <id>] [--var k=v] [--attempt <id>] [--ledger-dir <path>]` | Run a recipe. `--local` skips the bridge API; `--dry-run` executes nothing. |
| `install` | `recipe install <source>` | Install from `github:owner/repo[/subdir][@ref]`, `gh:…`, an `https://github.com/…` URL or a local path. Sources are checked against the install allowlist. |
| `uninstall` | `recipe uninstall <name>` | Remove an installed recipe. |
| `enable` / `disable` | `recipe disable <name>` | Pause or resume a recipe's scheduled, file-watch and git-hook triggers without uninstalling it. |
| `preflight` | `recipe preflight <file.yaml> [--json] [--watch] [--require-fixtures]` | Static validation plus the connector authorisations the recipe needs. |
| `doctor` | `recipe doctor <name\|file.yaml> [--json] [--local]` | Lint + write-policy + plan, composed with recent runtime halts from a live bridge, each mapped to a fix hint. `--local` skips the runtime half. **Exits 1 when unhealthy.** |
| `lint` | `recipe lint <file.yaml>` | Schema and best-practice checks: `git_hook.event` values, step `id` on event-triggered recipes, an agent step with tools but no `data_policy` (warning only). |
| `fmt` | `recipe fmt <file.yaml> [--check] [--watch]` | Format in place; `--check` only reports. |
| `schema` | `recipe schema` | Print the recipe JSON Schema. |
| `audit-env` | `recipe audit-env <recipe> [--env-file <path>]` | Check that every `{{env.FOO}}` the recipe uses is present. |
| `simulate` | `recipe simulate <name\|file.yaml> [--json] [--step <id>] [--var k=v]` | Static what-if preview: projected actions, side effects, risk, approvals, undetermined branches. Executes nothing. |
| `record` | `recipe record <file.yaml> [--fixtures <dir>]` | Record connector fixtures from a run so `recipe test` can replay it offline. |
| `test` | `recipe test <file.yaml> [--fixtures <dir>] [--watch]` | Run against fixtures with no external calls. An unmocked tool or unstubbed agent step is **refused**, never run live. |
| `rollback` | `recipe rollback <name> --run <taskId> [--dry-run] [--json]` | Undo an automated run's `file.write` / `file.append` side effects from its own attempt store (kept 14 days). The `--attempt <id> --ledger-dir <path>` form undoes a manual `recipe run` that used those flags. File tools only; there is no generic inverse for an issue, a message or a push. |
| `watch` | `recipe watch <file.yaml>` | Re-run preflight as the file changes. |

`simulate`, `record`, `test`, `rollback` and `watch` dispatch directly even though the short `recipe --help` index does not list them.

## Connectors

```bash
patchwork connect [list] [--json]
```

```bash
patchwork connect <vendor> [--url-only] [--token <TOKEN>] [--port <n>]
```

`connect list` shows every connector and its status. For an OAuth connector, `connect <vendor>` prints the authorise URL to open (`--url-only` for headless use); for a token connector, pass `--token`. `connect test <vendor>` health-probes one; `connect disconnect <vendor>` revokes it. `--port` targets a specific bridge. What each connector asks for is documented in [connector-scopes.md](../connector-scopes.md).

## Operate

| Command | Synopsis | Purpose |
|---|---|---|
| `start` | see above | Launch the stack. |
| `status` | `status [--port <n>] [--json]` | One line: lock file, port, uptime, session count. |
| `dashboard` | `dashboard` | Terminal dashboard: recent runs and the pending inbox. Bare `patchwork` does the same. Prints a pointer instead if `init` has not been run. |
| `members` | `members [list \| set-password <memberId>]` | The workspace roster and which members hold a credential. A member without one is reported as unable to authenticate; no `members.json` reports the single implicit owner. `set-password` prompts and stores a scrypt hash. |
| `tools` | `tools [list \| search <q>] [--slim] [--json]` | The tools the bridge would register, without starting it. `search` matches name, description and category. |
| `analytics` | `analytics show \| configure --endpoint URL [--key KEY] \| clear \| test` | Manage the opt-in telemetry config at `~/.claude/ide/analytics-config.json` (mode 0600). `test` sends a tiny synthetic payload and reports the HTTP status. Precedence: env, then config file, then default. |
| `launchd` | `launchd install \| uninstall \| status [--json]` | Install, remove, or report the macOS LaunchAgent `co.patchwork-os.bridge`. `status` exits 0 only when the agent is installed, loaded and running; otherwise 1, with the last exit code. |
| `install` | `install <companion> [--target cli\|desktop] [--env KEY=VALUE]` | Write one of the bundled MCP-companion server registrations into Claude Code (`~/.claude.json`) or Claude Desktop config. `install --list` names the companions. |
| `print-token` | `print-token [--port <n>]` | Print the auth token of the running bridge from its lock file. |
| `shim` | `shim` | The stdio↔WebSocket relay MCP clients use. Normally invoked by the client's config, not by hand. |
| `notify` | `notify <event> [--port <n>] […]` | Forward a Claude Code hook event (`PreCompact`, `PostCompact`, `InstructionsLoaded`, `TaskCreated`, `PermissionDenied`, `CwdChanged`) to the running bridge. Wired from `~/.claude/settings.json`. |

Developer-oriented commands in the same binary: `gen-claude-md [--write]` emits a CLAUDE.md bridge section; `gen-plugin-stub <dir> --name <org/name> --prefix <prefix> [--ts]` scaffolds a plugin; `quick-task <preset>`, `start-task "<description>"` and `continue-handoff` enqueue Claude subprocess tasks and need a bridge started with `--driver subprocess`.

### Bridge daemon flags

With no subcommand, `patchwork --workspace <dir>` starts a bridge in the foreground. `patchwork --workspace . --help` prints the full flag list. The ones an operator reaches for:

| Flag | Effect |
|---|---|
| `--port <n>` | Pin the port (default random). Pin it when OAuth callbacks or a dashboard are registered against it. |
| `--bind <addr>` | Bind address (default `127.0.0.1`). Anything else needs a reverse proxy — see [Security](security.md). |
| `--fixed-token <uuid>` | Stable auth token across restarts (default: new UUID each start). |
| `--approval-gate off\|high\|all` | The delegation gate level. Under `governed` the floor is `high`. |
| `--driver <mode>` | Model driver: `subprocess`, `api`, `openai`, `grok`, `gemini`, `gemini-api`, `codex`, `local` or `none` (default). Recipes with agent steps need one. |
| `--slim` / `--full` | Tool mode; full is the default. |
| `--watch` | Supervisor mode: restart on crash with exponential backoff. |
| `--grace-period <ms>` | How long a disconnected session is kept for reattachment. |
| `--issuer-url <url>` | Public URL; activates OAuth 2.0 mode for remote connectors. |
| `--webhook-secret <hex>` | HMAC-SHA256 secret for `POST /hooks/*`. |
| `--vps`, `--db` | Expand the command allowlist for server and database tooling. |
| `--plugin <path-or-package>`, `--plugin-watch` | Load plugins; hot-reload on change. |
| `--automation --automation-policy <path>` | Enable event-driven automation hooks (needs a driver). |
| `--config <path>` | Load a JSON config file instead of flags. |
| `--analytics on\|off` | Toggle anonymous usage analytics. |

## Diagnose

### `doctor`

```bash
patchwork doctor [--expect-running [N]] [--require-governed] [--json]
```

**Is the running code the installed code?** Compares each bridge lock's start time against the installed build's modification time — deliberately not a version comparison, because a stale and a fresh process report the same version. Also reports dead locks and ends with the governance posture (`STATUS: GOVERNED` or `NOT GOVERNED`, with reasons). **Exits 1 when unhealthy.** Without `--expect-running`, zero bridges is healthy; after a restart pass `--expect-running 2` (or however many you run) so an absent bridge cannot read as success. `--require-governed` also fails the exit code when the posture is not governed.

```bash
patchwork doctor health [--workspace <path>] [--port <n>] [--json]
```

Configuration checks: workspace, git binary, lock file, automation policy. **Exits 1 if any fails.** Without `--port` the lock check looks for a lock belonging to the CLI process itself and warns; that warning means "you did not say which bridge".

```bash
patchwork doctor acceptance [--json]
```

Proves the **installed package behaves**: seven in-process checks (identity, effective governed policy, policy-matrix refusal, kill switch, uncertain delivery never resent, mocked replay dispatches nothing, run lookup by task id). Runs against a fresh temporary `PATCHWORK_HOME` and `HOME`, loopback only, no connectors, no model calls; the real ledgers are never read or written. **Exits 1 if any check fails.**

### `halts` and `judgments`

```bash
patchwork halts [--window 1h|24h|overnight|7d|any] [--recipe <name>] [--json]
```

A one-screen summary of recent recipe halts, grouped by category with the most recent reasons, including violated `expect` contracts. Default window is `overnight` (since 6 pm yesterday, local time). `judgments` has the same shape and reports verdicts from `agent.kind: judge` steps.

### `approvals`, `approve`, `reject`

```bash
patchwork approvals [--window 1h|24h|overnight|7d|any] [--json]
```

The considered-approval KPI from the local decision log: reject rate, latency to decision, abandoned, dashboard versus phone. Read-only. To decide a single queued action from the terminal:

```bash
patchwork approve <callId>
```

`reject <callId>` is its mirror. Both prompt for confirmation on a TTY. These are listed under *Review* in `--help`.

### `sweep`

```bash
patchwork sweep [--dir <path>] [--expect-running [N]] [--no-write] [--json]
```

**What moved since the last sweep.** Composes `doctor`, `workers validate`, `evidence`, `privacy undeclared` and `pr-outcomes` into one reading, appends a counts-only snapshot to `sweep_snapshots.jsonl` and diffs it against the previous one. Only two readings are gates — deployment freshness and worker-manifest validity — and **it exits 1 only when one of those flipped healthy to unhealthy**. Everything else is drift and is reported without failing. A first run is a baseline, never "no changes". The snapshot holds counts only, never a recipe name, path or id.

### `evidence`

```bash
patchwork evidence [--dir <path>] [--json]
```

How much of the evidence spine can be joined: per ledger, how many rows carry a run id out of how many exist, and how many runs appear in more than one ledger. Prints counts only, never a row or an id, so its output is safe to quote. An absent ledger is reported absent, never as zero rows. **Always exits 0.**

```bash
patchwork evidence verify [--dir <path>] [--json]
```

Is every ledger internally intact? Walks the per-row hash chain, the chain-start commitment, the rotation marker, the head sidecar and unsealed write failures. **The only evidence verb that gates: exits 1 on any break, shortened file or unsealed write failure.** Prints line numbers and sequence numbers, never a value.

### `privacy`

```bash
patchwork privacy destinations [--json]
```

| Verb | Reports |
|---|---|
| `destinations` | Where prompts may go, and which destinations leave this machine. An empty registry is reported as **inert**. Names no retention or training claims, deliberately; put provider notes in an operator `note` with `noteReviewedOn`. |
| `receipts [--since-days N]` | What the live boundary actually decided, from `boundary_receipts.jsonl`. Leads with the denominator; never a bare refusal count. |
| `shadow [--since-days N]` | What the candidate policy under `privacy.shadow` would have stopped. An empty ledger reports "nothing observed". |
| `undeclared [--dir <path>]` | Which agent steps carry no `data_policy`, and which tool outputs feed them. Suggests no classification, on purpose. |
| `suggest` | A starter `privacy.shadow` block derived from the drivers your recipes declare. Emits the shadow key only, never the enforcing one. |

**Every `privacy` verb exits 0**: inert, wide-open and undeclared are all legitimate operator states. `receipts` and `undeclared` name real recipes, so quote a measurement from them and never paste the rows.

### `pr-outcomes`

```bash
patchwork pr-outcomes collect [--repo owner/name] [--limit N] [--json]
```

Appends raw pull-request observations to `pr_outcomes.jsonl` so trust can later be derived from evidence rather than asserted. Re-running appends nothing when nothing changed. `show` summarises the ledger, including how many pull requests have more than one observation. A failed GitHub query **exits 1** having recorded nothing. Rows name real pull requests and authors.

### `workers`

```bash
patchwork workers list [--workers-dir <path>] [--json]
```

| Verb | Purpose |
|---|---|
| `list` | What is installed and, the point, what the bridge **ignores**: a manifest that does not parse is skipped silently by the loader. **Exits 1 when any manifest is ignored.** |
| `validate [--recipes-dir] [--templates-dir]` | Every way a manifest can be present and govern nothing: unparseable file, `recipe:` not installed, two workers claiming one recipe (both are ignored), an unparseable `forbids` entry (fails open at runtime), drift from the shipped templates. **Exits 1 when unhealthy.** An empty directory reports "nothing to check". |
| `authority-delta [--base <ref>] [--head <ref>] [--dir <path>]` | What a change between two git refs does to a worker's **authority**: deleting a manifest, raising a ceiling across the compensable threshold, rebinding a recipe or renaming an id. An unreadable `forbids` entry is reported as a widening. **Exits 1 on a widening, 2 on an unreadable ref.** |
| `shadow` | Read-only trust dial per worker × action class: what the ramp *would* decide versus what the gate *did*. |
| `backtest` | Replays each worker's history and reports where the ramp would have auto-run a bad action or gated a good one. Calibration, not a success rate. |

`--workers-dir` defaults to `~/.patchwork/workers`.

### `gate explain`

```bash
patchwork gate explain <workerId> <classKey> [--limit N] [--diff] [--json]
```

Plain-English rendering of the most recent gate decision(s) for a worker × action class, read from `worker_gate_decisions.jsonl`; no bridge required. `classKey` is `domain:reversibility:blastTier`, plus a magnitude band on value-bearing domains. `--diff` compares the two most recent and prints only what changed.

### `outcomes`

```bash
patchwork outcomes confirm <issue-url> [--recipe <name>] [--class <actionClass>]
```

The operator's positive act: record that a worker's filing was real (`confirm`) or noise (`reject`) in `outcome-log.jsonl`, which is what moves the worker's trust dial. `--tool <t> --id <id>` references an action whose tool returned no URL. `list` prints recorded outcomes; `pending` lists filings awaiting confirmation with the exact command to confirm each. No recipe tool can do this, so a worker cannot confirm its own filings.

### Other diagnostics

| Command | Synopsis | Purpose |
|---|---|---|
| `codex doctor` | `codex doctor [--config <path>] [--json]` | Is `~/.codex/config.toml` wired to this bridge, and does its port and token still match the live lock file? A restart without `--fixed-token` rotates both. **Exits 1 when unhealthy**; no live bridge is a warning, not a failure. |
| `suggest` | `suggest [--since-days N]` | Co-occurring tool pairs not yet in a recipe, tools unused recently, recipes that have succeeded ten times running. Read-only. Default window 7 days. |
| `shadow-scan` | `shadow-scan [--since <duration\|ISO>] [--limit <n>] [--runs-file <path>] [--json]` | Replays historical runs through the destructive-tool classifier. **Exits 1 if any run would be reclassified.** |
| `runstore` | `runstore backfill \| compare [--json]` | Seed the durable run-store mirror from `runs.jsonl`, or report where the two disagree. Read-only with respect to `runs.jsonl`. `compare` prints ledger contents, so its output is operator data. |
| `traces` | `traces export [--output <path>] [--mode public\|keyed] [--passphrase <p>]` | Bundle runs, decision traces, commit-issue links and activity logs into one gzipped JSONL file; `keyed` encrypts with AES-256-GCM. `traces import <bundle> [--passphrase <p>] [--mode append\|overwrite] [--dry-run]` restores one. |
| `token-efficiency` | `token-efficiency [status \| benchmark --iterations N --threshold <ms>]` | Live session usage, or a round-trip benchmark against a running bridge. |

## Butler

```bash
patchwork butler shadow [--rows [N]] [--json]
```

The errand-outcome channel. `shadow` summarises the graded shadow ledger; `--rows` prints the individual graded rows (operator data). `observe [--file <path>] [--stale-after-days N]` discovers errands from the run log, looks up live task state and grades them. `ingest [--file <path>|-]` grades a JSON array of observations. `promote [--dry-run]` folds confirmed and junk grades into the trust ledger and **requires `PATCHWORK_FLAG_BUTLER_PROMOTE=1`**; without it, it reports without writing. Promotion is one-way, and an `unknown` grade is never promoted.

## Safety

### `kill-switch` and `panic`

```bash
patchwork kill-switch engage [--reason "..."]
```

`engage` blocks every write-tier tool call across every running bridge; `release` resumes; `status` prints engaged/locked state per bridge. **Exits non-zero if any bridge is unreachable or env-locked.** `patchwork panic [--reason "..."]` is an alias for `engage`, listed in help so it is findable in an incident.

### `profile`

```bash
patchwork profile [show|governed|compat] [--json]
```

`show` prints the resolved governance posture (the same lines `doctor` prints). `governed` and `compat` set the key in `config.json`; **a running bridge must be restarted** to pick up the change.

### `policy explain`

```bash
patchwork policy explain <recipe|file.yaml> [tool] [--json]
```

What this recipe can actually do right now, and why: walks every gate in runtime order — kill switch, tool registration, worker authority, tool tier, trigger, privacy, standing permission — using the same decision functions the runner enforces with. Pass a tool id (or `agent`) to restrict to matching steps. Read-only.

## Other

| Command | Purpose |
|---|---|
| `--version`, `-v` | Print the package version. |
| `help` | Same as `--help`. |
