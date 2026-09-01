# Claude IDE Bridge — Project Instructions

## Repository Scope

This repo is the **single-tenant Patchwork OS** (one bridge, one workspace, one user's policy). The **multi-tenant SaaS** (self-service signup, container-per-tenant, control plane, reverse proxy) is a **separate repo** at `../patchwork-multitenant` by explicit decision — **never add multi-tenant / control-plane / per-tenant-container code here.**

- That repo **forked** this bridge's `src/` (the tenant image builds `COPY src/` — `patchwork-multitenant/Dockerfile:23`). It was described here as a *verbatim vendored copy* kept in file-for-file sync; **it is not, and has not been for some time.** Measured 2026-08-21: 145 shared files differ, 114 paths exist only here, 15 only there (1310 vs 1192 `.ts` files). Absent from the fork entirely: `src/identity/`, `src/privacy/`, `src/runStore/`, `src/butler/`, `src/workspaceId.ts`, `src/approvalPersistence.ts`, `src/workers/{forbidPolicy,previewActions}.ts`. Its dashboard login route is a 410 stub and `memberAuth.ts` does not exist there.
  ⇒ **A fix landed here reaches zero hosted tenants**, and the governance surfaces that read those modules would be structurally empty in a hosted deployment. Do not scope hosted work as though the two trees agree — verify against `patchwork-multitenant/src/` first. The sync model is DECIDED — **[ADR-0023](docs/adr/0023-hosted-runtime-sync-model.md)**: the tenant image installs a pinned `patchwork-os` from npm instead of vendoring `src/`, the fork may add files but never edit package files, and the interim drift gate is transitional and must be deleted rather than silenced. Until that migration lands the trees still disagree, so treat "made here first, then snapshotted" as an aspiration rather than a description. Core features still stay tenant-agnostic (e.g. the recipe approval gate keys off the local bridge, not a tenant control plane).
- **Open-core boundary — [ADR-0019](docs/adr/0019-open-core-boundary.md).** This repo is MIT and stays MIT. `patchwork-multitenant` is ALSO MIT, and its **scope is frozen to infrastructure** (tenant provisioning, proxy, container plumbing). **Do not add governance features there** — organisation identity, policy inheritance, retention, signed audit export and approval routing belong in the separate non-MIT `patchwork-control-plane`. This rule exists because the default is silently wrong: those features would ship MIT just by being built where they naturally fit, and a published MIT commit cannot be withdrawn. The architectural line: **the open runtime emits evidence, only the control plane attests to it** — the local JSONL ledgers stay open-format and fully usable standalone.
- VPS/deploy scripts (`redeploy.sh`, `.env.prod`) live on the production box, not in either repo.

## Repository Privacy

> Deliberately inline rather than in `.claude/rules/`. That directory is
> **gitignored** (`.gitignore:62`), so every file there exists only on the
> machine that wrote it — a fresh clone gets none of them. A privacy rule
> living in an untracked file is a privacy rule nobody else has.

**This repository is MIT-licensed and world-readable, permanently.** Treat every
artefact as published the moment it is pushed: source, tests, fixtures, docs,
**commit messages, PR titles and bodies, issue text, and branch names**.

Commit messages and merged PR bodies are the ones people forget. They cannot be
quietly edited later — a force-push rewrites history others may already have
fetched, and a merged PR body is mirrored into notification email the moment it
lands. **The scan happens before the commit, never after the merge.**

### Never commit, quote, paste or attach

The local ledgers, in whole or in excerpt: `runs.jsonl` (and its rotation
archive `runs.jsonl.1`), `runs.db` / the run-store mirror, `run_steps.jsonl`,
`outcome-log.jsonl`, `worker_gate_decisions.jsonl`, `approval_log.jsonl`.

They hold real task titles, captured output tails, third-party issue URLs and
external record ids. `patchwork runstore compare --json` prints their contents:
real operator data wearing the shape of a diagnostic blob, and not safe to paste
into an issue, a PR body or a fixture.

Measurements taken *from* these files are fine; the contents are not. Cite "the
log retained 18 hours against a 24-hour window", never the rows.

### Never name a third party or an outside individual

No real third-party organisation names, domains, email addresses, customer
identifiers or account-specific recipe names in code, tests, docs or commit
text. Use neutral placeholders — `noisy-recipe`, `example.test`, `acct-0001`.

A real name already present in the tree is **not** permission to add more. It is
a defect not yet dealt with.

**Connector product names are the deliberate exception.** `jira`, `notion`,
`zendesk`, `cloudflare` and their siblings are shipped tool ids in public source
— unavoidable, and harmless alone. What must never appear is a product name
*paired with what anyone here does with it*: who uses it, how often, on what
schedule, at what volume.

### Never publish an operational statistic about a named party

"Recipe X is 85% of run volume" discloses two things: a fact about X, and that
we are positioned to measure it. The name may be public; the behaviour is not.

**The measurement is welcome, the attribution is not.** Write "one
high-frequency recipe held 85% of the log" — the engineering point survives, the
disclosure does not. Same rule for counts, volumes, schedules and error rates.

### Where a sensitive finding goes

A finding whose *disclosure is itself the harm* — "this file exposes X", "this
endpoint leaks Y" — does not go in a public issue, because the issue is the
exploit. It goes to the private operations tracker. Do not open a public issue
describing where confidential material is, or was: the pointer is the
disclosure, even when the material itself stays out.

### Privacy and governance features: fixtures pull real names in by gravity

Label taxonomies, destination registries, allow/deny lists and their fixtures
attract real-world names — a real vendor is the obvious example to reach for,
and reaching for it is the mistake. **Every example must be synthetic.** A
privacy engine that leaks in its own test data is the sharpest possible own
goal. Worker and errand fixtures follow the same rule: a worker's tasks are the
operator's real errands, so never use a real task title in a fixture, doc or
screenshot.

### The gate is not the scan

`scripts/audit-business-content.mjs` reads **tracked markdown** for commercial
content. It does not read commit messages. It does not read code or tests. It
cannot recognise a real third-party name used as a neutral-looking identifier.

**A green gate is not a clean scan.** Before every commit, push and PR, read the
diff, the commit text and the branch name yourself.

### The denylist gate — mechanical, and only as good as your list

`scripts/audit-private-identifiers.mjs` closes the part that can be automated.
It runs from `.husky/pre-commit` (staged diff + branch name) and
`.husky/commit-msg` (the message), and blocks the commit on a match — the three
things the section above says people forget.

**The denylist never enters the repository.** Those strings are exactly what
must not be published, so they cannot live in a tracked file. Put your list at
`~/.patchwork/private-identifiers.txt` — outside the repo, where `git add -f`
cannot reach it — one string per line. `PATCHWORK_DENYLIST` overrides the path;
a gitignored `.private-denylist` in the repo root also works but is one slip
away from being committed, and the gate hard-fails if it ever becomes tracked.

Three limits, all deliberate:

- **It does not run in CI.** CI has no denylist and must not have one. A CI step
  that always reported "not configured" would be noise, and noise is how a real
  warning gets ignored.
- **With no denylist it announces that it verified NOTHING and exits 0**, rather
  than blocking a contributor who never configured one. Set
  `PATCHWORK_DENYLIST_REQUIRED=1` to make that state a hard failure. It never
  passes *silently* — `audit-in-flight` spent its whole life doing exactly that.
- **`--no-verify` bypasses it**, and it only protects a machine that has the
  hooks installed. It is a seatbelt, not a wall.

It never prints the matched string — only which denylist entry number matched,
and where. Echoing it would put the secret into scrollback, CI logs and
screenshots, which is the same disclosure one layer over.

## Shipped-artifact identifier gate

`scripts/audit-shipped-identifiers.mjs` (CI-gating) scans `templates/` and
`examples/` for real-world identifiers by SHAPE — Slack channel ids and
`/Users/<name>` paths.

It exists because those directories are **distributed**: `package.json`'s
`files` includes `templates` wholesale, so a real identifier there is published
AND copied onto every installer's machine as working configuration. Found by
hand 2026-08-31 — a real Slack channel id shipped three times in one example
(labelled sales / marketing / engineering, all the same id) and a real workspace
channel name sat in a shipped template. Nothing was checking.

**It is not a duplicate of the private-identifier gate.** That one matches an
operator's denylist, which by design never enters the repo — so it cannot run in
CI and only ever sees a staged diff, a branch name and a commit message. It
could not have caught these: they were already committed. This one matches
shape, needs no secret, and therefore runs in CI. Complements, not overlap.

**The digit requirement in the Slack pattern is load-bearing.** `C` plus 8-10
uppercase alphanumerics also matches ordinary English — `COMPLETED`,
`CONSEQUENCE`, `CONVERSION` occur legitimately in nine places across shipped
recipes. Requiring a digit separates a real id from a word; without it the gate
fires on normal content and gets silenced.

**It deliberately does NOT judge domains or emails.** Real-vs-placeholder is a
knowledge question, not a shape one (`acme.test` and a genuine company differ by
what you know, not by form), and a guessing gate would either miss the real ones
or block legitimate placeholders. That half stays with the denylist gate and
with reading the diff. Known carve-out: a recipe whose FUNCTION is to filter
mail from a named service must name that service's sender address — the same
exception CLAUDE.md already makes for connector product names.

A scan of zero files FAILS rather than passing, so a moved or unreadable
directory cannot report OK.

## Documentation

Comply with all docs in `/documents/`. Consult before changes:

- **[documents/platform-docs.md](documents/platform-docs.md)** — Full feature reference (180 tools registered). Consult before adding/modifying features. Authoritative count: `node scripts/audit-lsp-tools.mjs` Stats line.
- **[documents/prompts-reference.md](documents/prompts-reference.md)** — All 36 MCP prompts reference.
- **[documents/styleguide.md](documents/styleguide.md)** — Code conventions, UI patterns, output formats. Follow for all new tools, handlers, responses.
- **[documents/roadmap.md](documents/roadmap.md)** — Development direction. Check before exploratory work.
- **[documents/data-reference.md](documents/data-reference.md)** — Data flows, state mgmt, protocol details. Consult before modifying connection/auth/state logic.
- **[documents/plugin-authoring.md](documents/plugin-authoring.md)** — Plugin manifest schema, entrypoint API, distribution.
- **[docs/adr/](docs/adr/)** — Architecture Decision Records. Read before touching version numbers, lock files, error codes, session mgmt, or reconnect logic.
- **[docs/runbooks/](docs/runbooks/)** — Operator runbooks for live campaigns (worker-autonomy-dogfood.md, etc.).

> **Cowork (computer-use) sessions:** MCP bridge tools NOT available inside Cowork. Run `/mcp__bridge__cowork` in regular Desktop chat first to capture IDE context, then switch to Cowork. Cowork runs in isolated git worktree — output won't appear in `git status` on main until merged. (see [docs/cowork.md](docs/cowork.md))

### CLI Subcommands

- `init [--workspace <path>]` — One-command setup: install extension + write CLAUDE.md + print next steps
- `start-all` — Launch tmux session with bridge + extension watcher panes
- `install-extension` — Install companion VS Code extension
- `gen-claude-md` — Generate starter CLAUDE.md for current workspace
- `print-token [--port N]` — Print auth token from active lock file
- `gen-plugin-stub <dir> --name <org/name> --prefix <prefix> [--ts]` — Scaffold new plugin (add `--ts` for TypeScript variant)
- `quick-task <preset>` — Launch a context-aware Claude task from a preset (fixErrors, refactorFile, addTests, explainCode, optimizePerf, runTests, resumeLastCancelled). Same dispatch path as the sidebar. Requires `--driver subprocess`.
- `start-task "<description>"` — Enqueue a free-form Claude task; Claude gathers its own workspace context.
- `continue-handoff` — Resume from the stored handoff note (skips auto-snapshots).
- `halts [--window 1h|24h|overnight|7d|any] [--recipe <name>] [--json]` — One-screen morning summary of recent recipe halts. Discovers the running bridge via lock file, queries `/runs/halt-summary`, formats per category + 5 most-recent reasons. Default window is `overnight` (since 6pm yesterday local). `--recipe` filters to a single recipe by name. Composes the haltReason field + category aggregator shipped in #441/#444.
- `recipe new <name>` — Scaffold a recipe from a template (`minimal` | `daily` | `inbox`). Add `--interactive` (or `-i`) to drop into the connector-aware prompt tree instead: mode pick (Guided / Template / AI-suggest), then step-by-step build. Generated YAML includes the SchemaStore pragma and runs `validateRecipeDefinition` post-hoc as warnings. AI-suggest discovers the running bridge via `~/.claude/ide/*.lock` and POSTs the goal to `/recipes/generate`; raw response written to disk (no form normalization).
- `--watch` — Auto-restart supervisor with exponential backoff (2s → 30s). Safe for production.

#### Recipe verbs (beyond `recipe new`)

- `recipe list` — Print installed recipes from the active bridge.
- `recipe install <source>` — Install from `github:owner/repo[/path][@ref]`. Same shape the dashboard install panel posts.
- `recipe uninstall <name>` — Remove a locally installed recipe.
- `recipe enable <name>` / `recipe disable <name>` — Flip the per-recipe disabled marker so cron / file-watch / git-hook triggers stop firing without uninstalling. Used by the dashboard's pause toggle.
- `recipe run <name> [--local --dry-run --step <id> --attempt <n> --ledger-dir <path> --var k=v]` — Manual run with overrides; `--local` skips the bridge API.
- `recipe rollback <name> --attempt <id> --ledger-dir <path> [--json]` — Undo a recipe attempt's `file.write`/`file.append` side effects, restoring each touched file to its pre-run content (or deleting it if the run created it). `<name>` must match the recipe's declared `name:`, and `--attempt`/`--ledger-dir` must match the original `recipe run` invocation. No bridge required — reads `${ledgerDir}/file_rollback.jsonl` (see `src/recipes/fileRollback.ts`), the pre-image counterpart to `--ledger-dir`'s idempotency ledger (PR5b). Ephemeral rollback: attempt-scoped undo of filesystem side effects, not a general version-control system, and deliberately narrow to file tools — undoing a GitHub issue creation, Slack post, or git push has no generic inverse and is out of scope.
- `recipe lint <file.yaml>` — Lint a recipe YAML against the schema + best-practice rules.

  **Three rules exist because lint and runtime had drifted, and drift here is
  silent and permissive — the recipe passes every check and never runs.**
  `compoundSteps.ts` and `dataPolicyPlacement.ts` were each written for an
  earlier instance of exactly this; these are the next three.

  - **`git_hook.event`** must be `post-commit` / `pre-push` / `post-merge`.
    `parseTrigger` throws otherwise, so the recipe is skipped at bridge startup
    with only a WARN in a log. Two live recipes named the key `on:` — the value
    was right, so nothing looked broken. A shipped template did too.
  - **Event-triggered recipes need a step `id` on every step.** `parseStep`
    calls `requireString(s, "id")`, so without one the recipe never registers.
    **Five shipped templates were dead this way.** Scoped to event triggers
    deliberately: 20 of 29 templates omit `id` somewhere and run fine, because
    the flat runner does not need it — a global rule would break most of the
    library to fix five files.
  - **A tool-enabled agent step with no `data_policy`** is a WARNING, never an
    error (ADR-0021 fail-soft: absent ⇒ `internal`). It marks the population
    most likely to be under-classified, and says in its own text that it cannot
    see a step whose driver is `auto`.

  A recipe that fails any of these is reported by `recipe doctor`, which is
  where an operator will actually look.

  **Completion contracts (`expect`) — three things changed 2026-08-26.**
  - **Run-level `expect` now runs on CHAINED recipes too.** It lints clean with
    zero warnings and was previously dropped entirely: `dispatchRecipe` casts a
    `YamlRecipe` straight across, so the block was on the object at runtime and
    `ChainedRecipe` simply had no field for it. `outputs` deliberately means
    **step ids** there and agent `into:` keys / resolved `file.write` paths on
    the flat runner — that is what each is keyed by — so a flat-style entry
    fails loudly rather than passing, and lint warns on a path-shaped entry
    (never on a flat recipe, where a path is correct).
  - **`expect.required`** (default false). A step skipped by its `when:` guard
    never evaluated its `expect`, so an expectation on a conditional step was
    unenforceable by construction. `required: true` makes the skip itself an
    `expect_failed` error. Scoped to the `when:` guard ONLY — the
    unregistered-tool skip stays silent by design, pinned by the guard test
    named *"skip paths that must NOT change"*.
  - **`patchwork halts` can see a violated contract** (`contract_failed`).
    Such a run finishes `done`, not `error`, so the run-level branch never
    fired. Counted ONE per run, not one per assertion, and NOT guarded on the
    step count — a postcondition violation is a different fact from a step
    error, not the same one restated.

  Two traps recorded because both cost a build: the committed JSON Schemas were
  **184 lines behind their generator**, because `schema:generate` emits JSON
  `biome check` rejects — so regenerating turned CI red and people stopped.
  `npm run build && npm run schema:generate && npx biome check --write schemas/
  dashboard/public/schema/`; the biome step is not optional, and
  `scripts/audit-generated-schemas.mjs` now gates it by comparing PARSED
  content (a byte gate would demand exactly the state the linter refuses). And
  the flat runner derives run-log step ids from `into`, never `step.id`, so a
  halt on a step with an explicit `id:` is reported as `step_N` — consistent
  everywhere, and not worth the blast radius of changing.

  **An unregistered tool id SKIPS the step silently, and that is DELIBERATE —
  do not "fix" it.** `executeStep` returns null for a tool nothing is
  registered under, the run loop records `skipped`, and the run finishes
  `done`. It is pinned by a guard test in a describe block named *"skip paths
  that must NOT change"* (`flatCompoundSteps.test.ts`), with the stated reason:
  forward compat for un-loaded plugins. Whoever landed the compound-step fix
  changed THAT class and carved this one out on purpose; changing it fails
  three tests across the flat path, the chained path and the SSE lifecycle.

  It reads like a fail-open defect and the concern is real — a plugin that
  fails to load produces a green run that did nothing. But the diagnosis
  already exists and is easy to miss: **`recipe doctor` reports it per step**
  as `(unresolved-tool) [step "x"] Tool "y" is not registered`, and marks the
  recipe unhealthy. Measured 2026-08-25: 20 unregistered ids across 14 of 82
  installed recipes, all from plugins that live elsewhere. Run `recipe doctor`
  before concluding anything is missing here. Two separate builds were spent
  rediscovering this.
- `recipe preflight <file.yaml>` — Connector preflight: list authorisations the recipe needs.
- `recipe doctor <name|file.yaml> [--json] [--local]` — One-screen "why is this recipe unhealthy + how do I fix it" diagnosis. Composes the static preflight check (lint + write-policy + plan) with the recipe-scoped runtime halt summary from a live bridge (`/runs/halt-summary?recipe=`), mapping every finding to an actionable hint (shared `HALT_CATEGORY_HINTS`/`HALT_CATEGORY_LABELS` in `src/recipes/haltCategory.ts`, also used by `halts`). Fail-soft: no bridge → static-only; a recipe too broken to plan → lint-only diagnosis (never stack-traces). `--local` skips the runtime check. Exits 1 when unhealthy. Same composition is exposed over HTTP at `GET /recipes/doctor?recipe=<name>` (name-only over HTTP; reuses `deps.haltSummaryFn` in-process) and surfaced in the dashboard as a **Doctor** panel on the recipe-detail page (needs the dedicated `api/bridge/recipes/doctor` proxy — the dynamic `recipes/[...name]` proxy would otherwise swallow the `?recipe=` query). Run-detail step rows also render the per-category fix hint next to `haltReason` (shared `HALT_CATEGORY_HINT` in `dashboard/src/lib/haltCategory.ts`).
- `recipe fmt <file.yaml>` — Format a recipe YAML in place.
- `recipe record <file.yaml> [--fixtures <dir>]` — Record CONNECTOR FIXTURES from a run so the recipe can later be exercised under `recipe test` with no external calls. Takes a file path, not an installed recipe name. There is no learned-trace concept in the tree; the previous description here named one and was wrong in both halves.
- `recipe schema` — Print the active recipe JSON schema.

**Flight recorder / mocked replay** (`POST /runs/:seq/replay`, dashboard run-detail page — no dedicated CLI verb): every successful tool step's output is captured onto `RunStepResult.output` (secret-redacted, 8 KB cap) for both chained recipes (VD-2, pre-existing) and flat manual/cron/webhook recipes (`src/recipes/yamlRunner.ts`'s `StepResult.output` + `captureForRunlog`). Replay re-runs the recipe with each captured step short-circuited to its prior output — `replayMockedRun` for chained, `replayFlatMockedRun` for flat (`src/recipes/replayRun.ts`) — so template/transform/expect wiring can be debugged against real evidence with zero external calls or write side effects. `runReplayFn` in `src/recipeOrchestration.ts` dispatches on the recipe's `trigger.type`; flat recipes previously hard-errored with `replay_only_supported_for_chained_recipes` before this capability existed. Real-mode replay (write tools actually fire) is deliberately out of scope — needs a confirmation UX + kill-switch interaction, ship separately.

#### Operational commands

- `start [--port N] [--workspace <path>]` — Single-bridge start (no tmux). Pair with `--watch` for supervised mode.
- `status` — One-line bridge status: lock file, port, uptime, session count.
- `tools [--slim] [--json]` — List tools the bridge would register without starting it.
- `tools list [--json]` — Same as bare `tools`, kept for symmetry with `search`.
- `tools search <query> [--json]` — Filter the registered tools by name / description substring.
- `install <companion>` — Install one of the bundled MCP-companion server registrations into Claude Desktop or Claude Code config. Use `--target cli|desktop` to choose, `--env KEY=VAL` to pass per-companion env vars. Companions: `memory`, `superpowers`, `devtools`, `database`, `slack`, `playwright`, `codebase-memory`. Each is a documented server config; the command writes it into `~/.claude.json` (CLI) or the Claude Desktop config (desktop) atomically.
- `codex doctor [--config <path>] [--json]` — Diagnoses whether `~/.codex/config.toml` is correctly (and *currently*) wired up to this bridge: config file exists, has a `[mcp_servers.claude-ide-bridge]` entry, the entry's `url` is well-formed, and — when a bridge is running — the config's port and Bearer token still match the live bridge's lock file. A bridge restart (without `--fixed-token`) rotates its port/token, silently staling out a previously-generated config with no error until Codex's next tool call 401s; this catches that before it surprises the user. Fail-soft like `recipe doctor`: no live bridge → warns, doesn't fail (config alone can be valid while the bridge just isn't started yet). Exits 1 when unhealthy. Codex CLI itself connects over Streamable HTTP, not the stdio shim — generate the config with `scripts/gen-mcp-config.sh codex`.
- `doctor [--json] [--expect-running [N]]` — **Is the running code the installed code?** Every other gate in this repo verifies the REPOSITORY; none looks at a running process. On 2026-08-19 both live bridges were found containing neither the ADR-0021 privacy code nor `butler` — merged, wired, tested, gated, and absent from every process serving requests, with three workstreams silently blocked for five days. Compares each bridge lock's `startedAt` against the installed build's mtime. **Deliberately NOT a version comparison**: in the live case both stale and fresh reported `1.2.0-beta.2`, because a version marks a release and not a build. Also reports dead locks (the shim discovers by lock file, so an orphan can win discovery) and refuses to judge a lock with no usable `startedAt`. Exits 1 when unhealthy.

  **`--expect-running [N]` (#1481) — because doctor cannot see a bridge that is not there.**
  Its denominator is *locks that exist*, not *bridges that should exist*, and
  `findings.some(...)` on an empty array is `false` — so zero bridges resolved to
  healthy and `patchwork doctor && echo deployed` printed `deployed` after a total
  failure to start. That is the worst possible moment for it: doctor is run
  immediately after a kickstart, which is exactly when a bridge is most likely to be
  absent. Observed 2026-08-20 — doctor printed one of two bridges and exited 0 while
  the second was still restarting. Pass `--expect-running 2` after a kickstart; bare
  `--expect-running` means at least one. Absent, zero bridges stays HEALTHY on
  purpose, since "nothing is running" is legitimate for anyone who never started one.
  A dead lock never counts toward the expectation (a corpse must not satisfy the
  check); a live-but-stale bridge does count as running, because staleness is already
  reported separately and conflating them sends the operator to the wrong remedy.

  **`doctor health` is a SEPARATE subcommand, and until 2026-08-26 it did not
  run at all.** `src/index.ts` had two top-level `argv[2] === "doctor"` blocks;
  the deployment-freshness one won every time, so `commands/doctor.ts`'s four
  config checks (workspace, git binary, lock file, automation policy) never
  produced output — `runDoctor` had exactly one production caller and it was
  unreachable. Its tests passed throughout because they call it directly with a
  mocked `runBridgeHealthChecks`: logic proven, wiring never exercised. Worse,
  `--help` was answered by the LOSING block, so the documented behaviour of
  `patchwork doctor` described checks that did not run and never mentioned
  `--expect-running`, the flag that does.

  Given a subcommand rather than folded in, deliberately: `doctor`'s exit code
  is load-bearing (it runs straight after a kickstart, and `patchwork doctor &&
  echo deployed` is a real shape), so letting a failing config check newly fail
  it would change a contract that already has users. Without `--port`,
  `doctor health`'s lock check looks for a lock belonging to the CLI process,
  which is never a bridge, so it warns — that means "you did not say which
  bridge", not "your bridge is broken".

  **What it does NOT answer: is the installed code the MERGED code.** There are
  three states, not two — `merged → installed → running` — and `doctor` guards
  only the second arrow. Measured 2026-08-19, an hour after #1461 merged and
  closed #1458: `doctor` printed `ok` for both bridges and exited 0, `grep
  cronClaim` against the installed `dist/` returned nothing, and the bug was
  still firing hourly in production. A green `doctor` on a stale install is not
  a contradiction; it is `doctor` answering the question it was built for.

  So a merge is not the end of a fix. The completion sequence, in order, and
  none of the steps is optional:

  ```
  git checkout main && git pull          # NEVER install from a feature branch
  npm run build
  npm run install:global                 # not `npm install -g .` — see the TCC note
  launchctl kickstart -k gui/$UID/co.patchwork-os.bridge   # :3101
  launchctl kickstart -k gui/$UID/com.patchwork.bridge     # :63906
  patchwork doctor                       # must exit 0
  ```

  Both bridges rebind in ~5 s. **Then verify the BEHAVIOUR**, because a
  timestamp comparison is not proof a code path changed: after deploying #1461
  the next cron slot produced 1 run row from 1 pid where the previous hour
  produced 2 from 2, a claim file appeared under `cron-claims/`, and the losing
  bridge logged `scheduled with cron expression` followed by `skipped … another
  process claimed this tick`. That last line is what distinguishes "the fix
  worked" from "the second bridge quietly stopped scheduling" — which produces
  an identical run-row count.
- `approvals [--window 1h|24h|overnight|7d|any] [--json]` — Recent approval decisions across bridges.
- `approve <callId>` — Approve one queued approval from the terminal. Prompts for confirmation on a TTY.
- `reject <callId>` — Reject one queued approval. Same shape as `approve`.
- `connect [list]` / `connect <vendor>` / `connect test <vendor>` / `connect disconnect <vendor>` — Connector authorisation from the terminal: list connectors and their status, start an OAuth flow or store a PAT, health-probe one, or revoke one. Documented in `--help` since it shipped and absent from this file until now.
- `butler <shadow|observe|ingest|promote>` — The errand-outcome channel.
  - `shadow [--json]` — summarise the graded shadow ledger.
  - `shadow --rows [N] [--json]` — print the INDIVIDUAL graded rows, evidence-bearing
    ones first. The summary's closing advice is to check a sample against the real
    errands before promoting, and until this existed there was no way to: `--json` gave
    the same aggregate, and the only caller of `readShadowRows` was
    `promoteShadowOutcomes` — the irreversible step. The one piece of code that read the
    rows was the one that acts on them. Output is **operator data**, like `runstore
    compare` and `privacy receipts`: it names real installed recipes and carries external
    record ids, so quote a measurement and never paste the rows.
  - `observe [--file <path>] [--stale-after-days N]` — discover errands from the run log, look up live task state, then grade. **Operator path only**: a recipe step runs AS the worker, and a worker that could observe its own filings could report them completed.
  - `ingest [--file <path>|-]` — grade a JSON array of observations.
  - `promote [--dry-run]` — fold confirmed/junk grades into the trust ledger. Requires `PATCHWORK_FLAG_BUTLER_PROMOTE=1`; reports without writing otherwise, because promotion is one-way (trust replay absorbs a folded row into a checkpoint that deleting the row does not undo).
- `dashboard` — Launch the local dashboard. Guards first run: without `patchwork init` it prints a pointer instead of an empty panel.
- `members [list|set-password <id>]` — Workspace roster plus which members hold credentials. Bare `members` lists. A member with no password is reported as `NO password — cannot authenticate`, and an absent `members.json` reports the single implicit owner rather than pretending a roster exists.
- `runstore <backfill|compare> [--json]` — Durable run-store maintenance. `compare` prints ledger contents, so its output is **operator data, not a diagnostic blob** — never paste it into an issue, a PR body or a fixture.
- `sweep [--dir <path>] [--expect-running [N]] [--no-write] [--json]` — **what MOVED since the last sweep.** Five read-only verbs already answer "what is true now" (`doctor`, `workers validate`, `evidence`, `privacy undeclared`, `pr-outcomes show`); run by hand they answer each question in isolation and none of the question an operator actually has, which is what changed. A denominator that has not shifted in three weeks and a gate that flipped yesterday look identical when every verb is read fresh. Appends a counts-only snapshot to `sweep_snapshots.jsonl` and diffs it against the previous one. **Only TWO of the five readings are gates** — deployment freshness and worker-manifest validity — and only a healthy→unhealthy flip exits 1. Everything else is DRIFT and never fails the command: the evidence ratios fall by construction as ledgers accrue rows faster than runs earn correlation ids, and an undeclared agent step is ADR-0021's documented fail-soft default. Wiring those to an exit code would make `sweep` permanently red, which is how a real warning gets ignored. **A first run is a BASELINE, never "no changes"** — nothing observed to change and nothing to compare against are different facts, the same distinction `evidence` draws between ABSENT and `0 rows`. A reading that could not be taken is OMITTED rather than recorded as zero, and a gate the previous snapshot never carried is not a flip (otherwise every newly-added gate fails its own first sweep). **The snapshot holds counts only** — no recipe name, no path, no id — which is a constraint and not a formality: two of the five inputs return operator data, and a health check is the last place anyone thinks to look for accumulated secrets, so the reduction to scalars happens at the collection boundary rather than in a formatter one refactor away from being lost. A mutation-checked test asserts a distinctively-named fixture recipe appears nowhere in the serialised snapshot. `rv` marks the schema; a row from another version is skipped rather than diffed across, because a counter name can survive a meaning change. Shares one implementation with each verb it composes (`scanRecipeDir`, `discoverLocks`/`installedBuildTimeMs`, `readObservations` were extracted for this) — two readers of the same number drift, and a drifting count is indistinguishable from a quiet week.
- `evidence [--dir <path>] [--json]` — **how much of the evidence spine can actually be joined?** Per ledger: how many rows carry a `correlationId` out of how many rows exist, plus how many runs appear in more than one ledger. Reports DENOMINATORS; it is deliberately not the cross-ledger reader, which the spine's own rule defers until there is evidence to read. An absent ledger is reported ABSENT, never `0 rows` — `butler/permission_exercises.jsonl` is absent because no standing permission has ever been granted, and rendering that as a zero invites someone to "fix" it. Prints **counts only, never a row, an id or any value**, because a `correlationId` IS a run's `taskId`; unlike `runstore compare` and `privacy receipts`, its output is therefore safe to quote. Always exits 0 — zero joinable rows is a true and expected state, and failing on it would make a correct answer look like an error.
- `shadow-scan [--since <duration|ISO>] [--limit <n>] [--runs-file <path>] [--json]` — Reclassification scan over the run log.
- `privacy suggest [--json]` — Derive a STARTER `privacy.shadow` block from the drivers your installed recipes actually declare. The destinations are MEASURED; the classifications are a conservative placeholder you are told to review. Reports agent steps that declare no driver separately rather than folding them in — they dispatch somewhere too. Emits `privacy.shadow` only, never the enforcing `privacy.destinations` key.
- `privacy undeclared [--dir <path>] [--json]` — **which agent steps carry no `data_policy`, and what feeds them.** ADR-0021 is fail-soft (absent ⇒ `internal`), which is correct as a default and makes an undeclared step invisible in a way a declared one is not. **Re-measured 2026-08-30: 0 undeclared of 74** agent steps across 72 installed recipes — the sweep completed and the population is GONE. The figure that stood here (58 of 77, 2026-08-26) is the one this file was quoting while scoping work against it, and it was stale by four days. Run the verb before citing either number; it exits 0 and takes a second. The remaining value of this command is now as a RATCHET — it is what stops the population regrowing as recipes are added — not as a to-do list. Reports the TOOL OUTPUTS feeding each undeclared step, because a step is classified by what it HANDLES *including whatever its tools return*: a prompt mentioning nothing sensitive can still be handed a mailbox by the step above it, which is why `morning-brief` declares `personal`. **Suggests no classification, deliberately** — a declared-but-wrong label is worse than an assumed one, because it stops looking like a gap (same reason `privacy suggest` emits only `privacy.shadow`, never the enforcing key). Always exits 0: an undeclared step is the documented default, not a failure. Output names real installed recipes, so it is **operator data** — quote a measurement, never the rows.
- `pr-outcomes <collect|show> [--repo owner/name] [--limit N] [--json]` — **raw pull-request events, so trust can be derived LATER from evidence rather than asserted now.** Built ahead of the workers that will read it, deliberately: this is the one item on the maintenance roadmap where that is correct, because outcome history accrues only with wall-clock time and a day not recorded cannot be recovered. Each row is an OBSERVATION — what the API said at one moment — so collecting regularly makes trajectories (diff size at open vs at merge, how long it sat, whether it grew) fall out, while collecting once gives final states only. The summary reports **how many pull requests have more than one observation**, so a one-shot backfill cannot read as months of evidence. **Derives no score**, on purpose: a scalar computed now would fix its weighting before there is anything to weigh it against, and every later question would have to be answered from a number that already threw the answer away. `authorIsWorker` is **OMITTED when no worker roster is configured, never recorded as false** — unknown and no are different facts, the same never-backfill rule `workerGateDecisionLog` states in its header. Re-running `collect` appends nothing when nothing changed, so row counts measure the repository and not how often the collector ran; a row that cannot be keyed is DROPPED rather than written with a placeholder; and a failed GitHub query exits 1 having recorded nothing, loudly, because a silent gap is indistinguishable from a quiet week. Rows name real pull requests and authors — **operator data** like the other ledgers, so quote a measurement, never paste the rows.
- `privacy destinations [--json]` — **where may prompts go, and which of those leave this machine?** The operator's choice already existed and was invisible: clearing a remote destination for `personal` is one line in `config.json`, and nothing said which destinations are off-machine or what clearing one means. Adds **no policy primitive**, deliberately — a recipe-scoped allow-list would put recipe identity into the decision point (which `recordBoundaryDecisionFn` explicitly keeps out of it) and would smuggle in `purpose` ahead of the per-field labels ADR-0021 reserves it for. **The disclosure names no retention period, deletion promise or training claim**, because such a claim rots without a code change — API retention moved 30 days to 7 in Sept 2025 and changed again in Aug 2026 — and a claim the code cannot keep is worse than none, because it is believed. It states only what is true by construction: the prompt leaves this machine, over the network, to the named destination. Provider behaviour goes in an operator `note` with `noteReviewedOn`; an undated or stale note is reported AS undated or stale. A LOCAL destination is never flagged however widely cleared — cleared for `restricted` is not a disclosure event when the data never leaves the box. An empty registry reports the boundary **INERT**, never "0 destinations". Always exits 0: inert and wide-open are both legitimate operator states. Two tests assert an ABSENCE (no retention/training claim anywhere in the output) and are mutation-checked.
- `privacy shadow [--since-days N] [--json]` — What a candidate policy WOULD have stopped, without enforcing it (ADR-0021). Leads with the DENOMINATOR and refuses to print a bare crossing count; an empty ledger reports "nothing observed", never "0 crossings". Reads `privacy_shadow.jsonl`.
- `privacy receipts [--since-days N] [--json]` — What the LIVE policy actually DID: a reader over `boundary_receipts.jsonl`, the ADR-0021 enforcement ledger (`privacy shadow` is its counterfactual sibling — what a CANDIDATE policy would have stopped). Reads the file rather than `BoundaryReceiptLog`, which trims to 500 rows on load and on every write, so a summary built on `.summary()` would serve 500 as a total. Leads with the DENOMINATOR and never prints a bare refusal count; an absent ledger reports "nothing recorded" and says the boundary is inert until a destination is registered, never "0 refusals". Also `GET /privacy/receipts` and the dashboard's **Data boundary** page under Activity. Like `runstore compare`, its output is **operator data, not a diagnostic blob** — it names real installed recipes and their dispatch volumes, so it must never be pasted into an issue, a PR body or a fixture. Quote a measurement ("N of M were refused"), never the rows.
- `kill-switch engage|release|status [--reason <text>]` — Toggle the global write-disable gate (see ADR-0013).
- `analytics show|configure|clear|test` — Manage the opt-in telemetry collector config (endpoint + shared secret) at `~/.claude/ide/analytics-config.json` (mode 0600). Replaces the brittle pattern of putting the secret in a launchd plist. `configure --endpoint URL --key KEY` writes both atomically; `test` sends a tiny synthetic payload and reports the HTTP status; `show` prints active values and resolution source (env / config / default). Env vars still win for headless/CI.
- `panic` — Shortcut for `kill-switch engage --reason "manual panic"`.
- `judgments [--window 1h|24h|overnight|7d|any] [--recipe <name>] [--json]` — Recent judge-step verdicts (from recipe steps with `agent.kind: judge`) across runs. Discovers the running bridge via lock file, queries `/runs/judge-summary`, prints per-verdict counts + 5 most-recent. Sibling of `halts`; same window/filter shape.
- `workers list [--workers-dir <path>] [--json]` — what is installed and, the point, **what the bridge IGNORES**. `loadWorkersFromDir` is fail-soft: a manifest that does not parse is SKIPPED, and it logs only when the caller passes a logger — which the resolution path does not. Exits 1 when any manifest is ignored.
- `workers validate [--workers-dir <path>] [--recipes-dir <path>] [--templates-dir <path>] [--json]` — every way a manifest can be present and govern NOTHING. All of them end identically: `resolveWorkerIdForRecipe` returns undefined, the caller falls back to the tier-based approval fn, and the worker ramp never runs. Since the worker gate is composed as a FLOOR over the tier fn (it can only ADD approvals), losing it means the recipe is governed **less**, and a manifest's ADR-0017 `forbids` list goes inert without a word. Checks: unparseable manifest · `recipe:` not installed · two workers claiming one recipe (**BOTH are ignored — resolution refuses to guess, so there is no winner**) · an unparseable `forbids` entry (**fails OPEN** — the banned action degrades to merely gated, which a human can then approve) · drift against `templates/workers`. Exits 1 when unhealthy. Leads with the denominator: an empty directory reports "nothing to check", never "no problems". Measured 2026-08-26 on the reference install — 8 manifests, all parsing, none dangling, none ambiguous, no drift — so the validator was built against deliberately broken fixtures, since one that has only seen healthy input is not known to be able to fail. **No `install` verb**, deliberately: a package format has to answer the third-copy problem (`templates/workers/` and `~/.patchwork/workers/` already diverge, which is why `manifestDrift` exists), and that is a design decision rather than a missing function.
- `workers authority-delta [--base <ref>] [--head <ref>] [--dir <path>] [--json]` — **what does this change do to a worker's AUTHORITY?** Compares worker manifests between two git refs and reports structured findings, so a repository gate can block on a widening before it lands. Reuses the runtime primitives (`parseForbidRules`, `TrustLevel`, the gate's own `COMPENSABLE_AUTONOMY_LEVEL`) rather than re-deriving authority from a diff — two notions of authority would drift, and the drift is silent and permissive. **One inversion, and it is the point:** `parseForbidRules` reports unparseable entries and DROPS them, which fails OPEN at runtime and is correct there (a banned action degrading to merely gated is recoverable, because a human still approves it). A repository gate cannot inherit that — "I could not read your deny-list" must never resolve to "looks fine" — so an unreadable `forbids` entry is reported as a WIDENING. Same classifier, inverted failure mode. Three findings are non-obvious and are why this is not a diff pretty-printer: **deleting a manifest is a widening** (the gate composes as a FLOOR over the tier fn, so removing it leaves the recipe governed LESS, and any `forbids` list goes inert silently); **`ceiling: 1 → 2` crosses `COMPENSABLE_AUTONOMY_LEVEL`**, converting every compensable class the worker owns from "a human decides" to "it happens" — the manifest's own doc notes ceiling 2 is PERMISSIVE, not conservative, so "+1" is the wrong mental model; and **rebinding `recipe:` or renaming `id`** swaps the body under a dial the old body earned, since trust is keyed per (workerId × actionClass). Keyed by manifest FILE, not by worker id, so a rename surfaces as `identity-changed` rather than as a delete plus an add. No model, no scoring: every finding is a set difference or a numeric comparison over declared fields. Exits 1 on a widening — which is not a defect, and often exactly what was intended; it requires a person to say so. An unreadable ref exits 2 rather than reporting an empty set, because empty would render every worker as newly added.
- `workers shadow [--workers-dir <path>]` — Replay run + gate logs to show per-worker × action-class trust dial and ramp-vs-gate divergences. Primary monitoring tool during the worker autonomy dogfood campaign. See [docs/runbooks/worker-autonomy-dogfood.md](docs/runbooks/worker-autonomy-dogfood.md).
- `workers backtest [--workers-dir <path>]` — Cold-start calibration: replay historical runs as if the gate were live; measures how many shadow divergences the gate would have produced.
- `gate explain <workerId> <classKey> [--limit N] [--diff] [--json]` — "Why did the worker allow/gate THIS action?" Plain-English rendering of the most recent decision(s) for a worker × action-class, from the local Decision Record (`~/.patchwork/worker_gate_decisions.jsonl`) — no bridge required. `--limit N` shows the N most recent (default 1, or 2 with `--diff`). `--diff` compares the 2 most recent decisions and reports only the fields that changed (e.g. `action: gate → allow`) — Tier 2 of the legibility layer. `classKey` is `domain:reversibility:blastTier`, plus a `:magnitudeBand` suffix for value-bearing domains (e.g. `issue:compensable:high`, `payments:irreversible:high:band<=50`). Also exposed over HTTP at `GET /gate/decisions?workerId=&classKey=&limit=` for the dashboard.
- `outcomes confirm|reject <issue-url> | --tool <t> --id <id> [--recipe <name>] [--class <actionClass>]` / `outcomes list [--json]` — Operator positive-act confirmation of a worker-filed issue. Writes an outcome disposition (`confirm`→confirmed, `reject`→junk) to the trust-replay store (`~/.patchwork/outcome-log.jsonl`, the same file the outcome-ingester cron writes and `WorkerShadowObserver.ingestRun` reads) — no bridge required. This is the local alternative to closing/labelling the issue on GitHub. **A worker cannot self-confirm its own filings — but NOT because this verb is CLI-only, which is what this line used to claim.** `outcomes.classify_issues` (`src/recipes/tools/outcomes.ts`) is a recipe tool that also writes dispositions to `OutcomeStore`, so the CLI-only path secures nothing on its own. What actually holds the property is a chain of three, and the middle one is a load-bearing ABSENCE: (1) `classifyIssueDisposition` is a pure function of the issue's own GitHub state — no LLM, after a judge was removed for flipping the same issues between runs; (2) **no recipe-facing `github.*` tool can mutate that state** — the surface is `create_issue` plus four reads, with no close, label, update or comment; (3) `http.post` cannot resolve connector tokens and `{{env.X}}` exposes only keys a recipe declares in a `context: env` block. Break (2) — by adding `github.close_issue` or `github.add_label`, both obviously reasonable features — and a worker can file an issue, close it as completed, and have `classify_issues` record `confirmed`, climbing the ramp on evidence it manufactured. `src/recipes/tools/__tests__/githubIssueMutationGuard.test.ts` fails if that surface widens. Since a durable `unknown` filing is withheld (never earns trust), a `confirmed` disposition — here or via GitHub close-as-completed — is the only thing that moves a worker's `issue` dial. **The join key is generalised beyond URLs**: `--tool <t> --id <id>` references an action whose tool returned no URL (e.g. `todoist.create_task`, which exposes no permalink field at all). Records key on `ref` → `"<tool>:<id>"` when present, else the legacy `issueUrl`; the two namespaces cannot collide (`canonicalActionRef` refuses a URL-shaped key). Existing rows are deliberately NOT migrated — a URL is already a fine key and rewriting the ledger the gate rests on buys only uniformity. Rows carrying neither key are now REPORTED (`OutcomeStore.unkeyableRows()`) instead of silently dropped, and `upsert` refuses to write one. **The strict join is ON by default** (#1319) — a non-reversible success with no recorded disposition is WITHHELD, where it previously earned full trust. Measured before flipping: exactly one step changed label across the real run log. It was small because only 1 of 63 non-reversible successes was keyable at the time — 50 were `agent` steps that capture no output and 12 were `http.post` whose id sits inside a JSON string body. **Both of those have since been addressed and the figure is stale**: #1320 withholds `agent` steps by design (they are not evidence, so a key would not help), and #1322's one-level `body` dip reads the `http.post` ids. Re-measured 2026-08-16 across the live run log: of 187 successful steps, 46 are `agent` (withheld), 124 are reversible (which never need a key), leaving **17 non-reversible of which 11 are keyed — 65%, not 1.6%**. The residual is 6 `fan_out` steps, a control construct whose children are the real actions. **Do not quote "11 of 187"**: the 187 denominator counts steps that structurally cannot and need not join, so it understates coverage by an order of magnitude. The live constraint is evidence VOLUME — only 17 non-reversible successes exist in the whole log — not join-key coverage. `PendingConfirmation` is keyed by `actionKey` (not `issueUrl`) for the same reason the fold is: a queue keyed differently from the fold would withhold an action it never offers for confirmation — an invisible permanent denial. `--recipe`/`--class` stamp audit context. Core logic in `src/workers/outcomesCli.ts`.
- `suggest [--since-days N]` — Recipe co-occurrence + unused-tool suggestions from recent activity.
- `traces export [--passphrase <p>] [--mode keyed|public] > file.jsonl` — Export decision traces; `--mode keyed` encrypts with the passphrase.
- `traces import [--passphrase <p>] [--dry-run] < file.jsonl` — Restore traces from an export.
- `token-efficiency benchmark [...]` — Measure token cost across slim/full tool sets.
- `launchd install|uninstall|status` — Manage the macOS LaunchAgent for the bridge (auto-start at login).
- `orchestrator [--port N] [--workspace <path>]` — Start a multi-bridge orchestrator (parent/child topology).
- `notify <event> [...]` — Forward a Claude Code hook event to the bridge `/notify` endpoint (wired from `~/.claude/settings.json`).
- `shim` — stdio MCP bridge for Claude Desktop. Auto-invoked by Desktop's `claude_desktop_config.json`; not normally run by hand.

#### Environment variables

Most users don't need to touch these — CLI flags cover the common cases. Listed here so deployments and supervisors have a complete reference.

| Var | Effect |
|---|---|
| `CLAUDE_IDE_BRIDGE_TOKEN` | Override the auto-generated auth token in the lock file. Use with `--fixed-token` in deployments. |
| `CLAUDE_IDE_BRIDGE_CONFIG` | Path to a JSON config file the bridge reads at startup (alternative to CLI flags). |
| `CLAUDE_IDE_BRIDGE_GRACE_PERIOD` | ms (default 120000) — session-restore window after WebSocket disconnect. Equivalent to `--grace-period`. |
| `CLAUDE_IDE_BRIDGE_EDITOR` | Editor identity reported on `extension/hello` (default auto-detect). |
| `CLAUDE_IDE_BRIDGE_LINTERS` | Comma-separated linter binaries the bridge will probe for. |
| `CLAUDE_IDE_BRIDGE_TIMEOUT` | ms (default 30000) — tool execution timeout. |
| `CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE` | bytes — cap on tool result payload size before truncation. |
| `CLAUDE_IDE_BRIDGE_ISSUER_URL` | Equivalent to `--issuer-url`; activates OAuth 2.0 mode. |
| `CLAUDE_IDE_BRIDGE_CORS_ORIGINS` | Comma-separated CORS origins (alternative to repeated `--cors-origin`). |
| `CLAUDE_IDE_BRIDGE_TRUST_PROXY` | Truthy → trust `X-Forwarded-For` (set when running behind nginx/Caddy). |
| `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS` | Comma-separated hostnames for `/recipes/install` source allowlist (default `github.com`). |
| `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL` | Path override for recipe-runner temp directory. |
| `BRIDGE_WEBHOOK_SECRET` | Equivalent to `--webhook-secret`; HMAC-SHA256 auth on `POST /hooks/*`. |
| `PATCHWORK_HOME` | Override `~/.patchwork` workspace root. |
| `PATCHWORK_BRIDGE_URL` / `PATCHWORK_BRIDGE_PORT` | CLI subcommands use these to find the bridge instead of the lock file (useful in remote-bridge setups). |
| `PATCHWORK_DASHBOARD_URL` | Public base URL the OAuth callback is served from — FIRST in the `redirect_uri` precedence chain for every OAuth connector (`src/connectors/connectorRedirectUri.ts`). Must include the dashboard basePath (e.g. `https://example.com/dashboard`). Changing it changes the `redirect_uri` sent to every provider, so it must match what is registered on each OAuth app. Not read by any CLI "open" action. |
| `PATCHWORK_CLAUDE_BINARY` | Equivalent to `--claude-binary`; path to the `claude` CLI. |
| `PATCHWORK_RECIPE_REPO_ALLOWLIST` | Comma-separated `owner/repo` allowlist for recipe install sources. |
| `PATCHWORK_TOKEN_DIR` / `PATCHWORK_TOKEN_STORAGE_BACKEND` | Connector-token storage location + backend (`file` vs `keychain`). |
| `PATCHWORK_CRON_CLAIM_REQUIRED` | Truthy → a scheduled recipe SKIPS its tick when the cross-process claim store is unwritable, instead of firing anyway (#1458). Default off, i.e. fail-OPEN: the conditions that break the store are machine-level, so failing closed would stop every scheduled recipe on every bridge at once rather than allowing one duplicate. Set this where a duplicate is worse than a miss — recipes that send email or post publicly. `EEXIST` is not a failure and is unaffected: that is a peer holding the tick. |
| `PATCHWORK_FLAG_KILL_SWITCH_WRITES` | Feature flag — gate write tools on kill-switch state. |
| `PATCHWORK_FLAG_UI_SCHEMA_LINT` | Feature flag — strict UI-schema linting in the recipe editor. |
| `PATCHWORK_FLAG_BUTLER_PROMOTE` | Feature flag — let `patchwork butler promote` fold graded Butler shadow rows into the trust ledger (`outcome-log.jsonl`). Default off, and the flag is a decision about EVIDENCE rather than about code: promotion is one-way, since trust replay absorbs a folded row into a checkpoint that deleting the row does not undo. `unknown` grades are never promoted under any flag. Operator path only — never a recipe tool, so a worker cannot promote its own filings. |
| `PATCHWORK_FLAG_WORKER_AUTONOMY` | Feature flag — enable trust-ramp-aware autonomy gate for worker recipes. Gates compensable/irreversible automated recipe actions until the owning worker earns L4 trust on that action-class; reversible actions always flow freely. Default off. Requires `--driver subprocess`. |
| `LOCAL_MODEL` / `LOCAL_ENDPOINT` / `LOCAL_API_KEY` / `LOCAL_ENDPOINT_ALLOW_REMOTE` | Local-model driver config (Ollama / vLLM / OpenAI-compatible endpoint). |
| `OTEL_SERVICE_NAME` | Override the OTel service name (default `claude-ide-bridge`). |
| `PATCHWORK_ANALYTICS_ENDPOINT` | Override the opt-in telemetry collector URL (default `https://analytics.claude-ide-bridge.dev/v1/usage`). Must be `http(s)://`; invalid values fall back to default. Per-call resolution; precedence: env > config file > default. For CI/headless. Prefer `patchwork analytics configure` for persistent setups — keeps the secret out of launchd plists. |
| `PATCHWORK_ANALYTICS_KEY` | Shared-secret sent as `X-Analytics-Key` header on telemetry POSTs. Only meaningful when paired with a self-hosted endpoint that checks it. Same precedence as endpoint. |

##### Connector credential env vars

Per-connector env override for OAuth client credentials (when self-hosting OAuth apps) or for PAT-style direct-token connectors. The dashboard `/connections` UI is the recommended setup path — these env vars are for headless / CI / scripted deployments. Setting `*_CLIENT_ID` + `*_CLIENT_SECRET` lets the bridge use your own GitHub/Slack/etc. OAuth app instead of the public one.

| Var(s) | Connector | Type |
|---|---|---|
| `PATCHWORK_GITHUB_CLIENT_ID` / `PATCHWORK_GITHUB_CLIENT_SECRET` | GitHub | OAuth app override |
| `PATCHWORK_SLACK_CLIENT_ID` / `PATCHWORK_SLACK_CLIENT_SECRET` | Slack | OAuth app override |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Gmail | OAuth app override |
| `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` | Google Calendar | OAuth app override |
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` | Google Drive | OAuth app override |
| `ASANA_CLIENT_ID` / `ASANA_CLIENT_SECRET` | Asana | OAuth app override |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord | OAuth app override |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_BASE_URL` | GitLab | OAuth app override + self-hosted base URL |
| `JIRA_API_TOKEN` / `JIRA_EMAIL` / `JIRA_INSTANCE_URL` | Jira | PAT-style token |
| `CONFLUENCE_API_TOKEN` / `CONFLUENCE_EMAIL` / `CONFLUENCE_INSTANCE_URL` | Confluence | PAT-style token (HTTPS atlassian.net only) |
| `LINEAR_API_KEY` | Linear (non-MCP fallback) | PAT-style token |
| `NOTION_TOKEN` | Notion | PAT-style token |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot | PAT-style token |
| `INTERCOM_ACCESS_TOKEN` | Intercom | PAT-style token |
| `DATADOG_API_KEY` / `DATADOG_APP_KEY` / `DATADOG_SITE` | Datadog | PAT-style (`SITE` enum-allowlisted) |
| `PAGERDUTY_TOKEN` / `PAGERDUTY_FROM_EMAIL` | PagerDuty | PAT-style token |
| `ZENDESK_API_TOKEN` / `ZENDESK_EMAIL` / `ZENDESK_SUBDOMAIN` | Zendesk | PAT-style token |
| `SENTRY_AUTH_TOKEN` | Sentry (non-MCP fallback) | PAT-style token |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot-token PAT (from @BotFather) |

##### Dashboard env vars (Next.js side)

The dashboard reads these from `dashboard/.env.local` / `.env` at startup. Most users don't change them — defaults pick a free port and assume a single-user local install.

| Var | Effect |
|---|---|
| `DASHBOARD_PASSWORD` | Single-user password gate for the dashboard. Required for any non-local deployment. |
| `DASHBOARD_SESSION_SECRET` | Cookie-signing secret (random hex ≥ 32 chars). |
| `DASHBOARD_ALLOW_UNAUTHENTICATED` | `1` to bypass the password gate (local dev only). |
| `DASHBOARD_AUTH_FAILURE_WINDOW_MS` / `DASHBOARD_AUTH_MAX_FAILURES` / `DASHBOARD_AUTH_LOCKOUT_MS` | Brute-force lockout tuning for the login form. |
| `PATCHWORK_BRIDGE_TOKEN` | Bearer token the dashboard uses when forwarding to a remote bridge (paired with `PATCHWORK_BRIDGE_URL`). |
| `NEXT_PUBLIC_BASE_PATH` | basePath for mounted-prefix deployments (`/dashboard` under nginx, etc.). |
| `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web Push (PWA notifications). |
| `PATCHWORK_PUSH_TOKEN` / `PATCHWORK_PUSH_URL` / `PATCHWORK_PUSH_BASE_URL` | Phone-path push relay credentials (used by the optional remote relay; see ADR-0006). |

## Bug Fix Protocol

When bug reported, do NOT fix first. Instead:
1. Write test that reproduces bug (test must fail)
2. Have subagents fix bug and prove it with passing test
3. Only then consider bug fixed

## Build & Test

```bash
# Bridge
npm run build          # TypeScript compilation (wipes dist/ first)
npm test               # vitest

# Extension
cd vscode-extension
npm run build          # esbuild bundle
npm run package        # create .vsix

# Always rebuild bridge + extension + VSIX before testing changes
```

**Extension versioning rule:** Windsurf caches `.vsix` files by version number and will silently reuse the old bundle if the version hasn't changed. **Always bump `vscode-extension/package.json` version before packaging** when the user will install the `.vsix` in Windsurf (or any VS Code fork). Patch bump (`1.4.2` → `1.4.3`) is sufficient. Never repackage without bumping — the user will install it and see no change.

**Local global install rule (macOS):** Never run `npm install -g .` from a workspace under `~/Documents/`, `~/Desktop/`, or `~/Downloads/`. npm creates a symlink from `/opt/homebrew/lib/node_modules/<pkg>` into the workspace, and macOS TCC then silently blocks launchd-spawned processes from following that symlink (EPERM). The LaunchAgent will appear to install correctly but fail on first reload with `code: 'EPERM'`. Use `npm run install:global` (wraps `npm pack` + `npm install -g <tgz>`) instead — produces a real-copy install outside TCC's protected directory tree.

Before staging, run `npx biome check --write <files>` on changed files. Fix before stage — don't wait for hook to fail.

**Release channels:**
- `latest` / `beta` — manual via `chore(release):` PRs, tagged `v*-beta*` → `publish-npm.yml`. Stable / human-curated.
- `canary` — automatic on every green main merge via `publish-canary.yml`. Version shape `<base>.canary.<runNumber>` (e.g. `0.2.0-beta.5.canary.42`). `npm install -g patchwork-os@canary` always tracks main. Use for dogfooding freshly-merged changes without waiting for the next release PR. Never default-installed.

## LSP Workflows

All LSP tools available in both slim and full mode (full is the default since v2.43.0).

**Adding a new tool**
1. `searchWorkspaceSymbols` — confirm similar tool doesn't exist
2. `getDocumentSymbols` on `src/extensionClient.ts` — see available methods
3. `getHover { filePath, line, column }` — verify method signature before writing
4. `getDiagnostics { uri: "src/tools/myTool.ts" }` — catch type errors before `npm run build`
5. `getDiagnostics { uri: "src/tools/index.ts" }` — confirm no import errors after registering

> `getDiagnostics` uses `uri`, not `filePath`. Wrong key silently returns all-workspace diagnostics.

**Code review**
1. `getCallHierarchy { direction: "incoming" }` on each changed symbol — blast radius
2. `findReferences` on changed interfaces/types — find all implementation sites including test mocks
3. `getCodeActions` on flagged ranges — surface language server suggestions
4. `setEditorDecorations { id: "code-review", style: "warning"|"error", hoverMessage, message }` — annotate inline
5. `clearEditorDecorations { id: "code-review" }` when done

**Refactoring**
1. `refactorAnalyze` — returns `risk` (low/medium/high), `referenceCount`, `callerCount`. High risk (>20 refs or >10 callers) → write tests first per Bug Fix Protocol.
2. `refactorPreview` — see exact edits before committing
3. `renameSymbol` — execute; or `refactorExtractFunction { file, ... }` (param is `file`, not `filePath`)
4. `getDiagnostics` with no `uri` — workspace-wide type check (uses CLI/tsc when extension not connected)

**Debugging**
1. `searchWorkspaceSymbols` — jump to symbol from stack trace
2. `getCallHierarchy { direction: "outgoing" }` on failing handler — trace data flow
3. `getDocumentSymbols` on `src/extensionClient.ts` vs test mock — catch interface drift
4. `setDebugBreakpoints` + `evaluateInDebugger` — inspect runtime state

**Onboarding to unfamiliar code**
1. `getDocumentSymbols` — instant file outline
2. `explainSymbol` on primary export — richer than hover alone
3. `getCallHierarchy { direction: "incoming" }` — what depends on this module
4. `getImportTree` — full downstream dependency chain

**Quick reference**

| Situation | Tool |
|---|---|
| Tool for X exist? | `searchWorkspaceSymbols` |
| Method accepts what? | `getHover` |
| Hover N symbols | `batchGetHover` |
| Definition N symbols | `batchGoToDefinition` |
| Implementations N symbols | `batchFindImplementations` |
| Change breaking? | `getChangeImpact` or `getDiagnostics` + `findReferences` |
| Caller count? | `getCallHierarchy { direction: "incoming" }` |
| Safe to rename? | `refactorAnalyze` → `refactorPreview` → `renameSymbol` |
| File exports? | `getDocumentSymbols` |
| File imports (signatures)? | `getImportedSignatures` |
| Links / file refs in doc? | `getDocumentLinks` |
| Code lens counts? | `getCodeLens` |

## Governed Profile (ADR-0026)

`config.json` `profile: "governed" | "compat"` — **[ADR-0026](docs/adr/0026-governed-profile.md)**.
Absent ⇒ `compat`, byte-identical to before. `patchwork init` writes `governed`
for a NEW config only; `patchwork profile governed|compat` changes an existing
one (restart the bridge). The profile resolves to EXISTING primitives
(`src/governance/profile.ts`): approval gate floor `high`, automated triggers
gated like manual, `FLAG_WORKER_AUTONOMY` + `FLAG_ENFORCE_POLICY` on, agent
steps contained by default (Read/Glob/Grep/LS; WebFetch/WebSearch/Bash denied;
env allowlist; no bridge MCP), recipe `servers:` allowlisted via
`config.plugins.allow`, kill switch fails CLOSED when unreadable, non-reversible
and inferred-tier writes queue, unregistered tools halt, a recipe's
`requireApproval: false` is ignored, connector output is wrapped in an
`<untrusted>` envelope in agent prompts.

- **One calculation.** `computeEffectivePolicy` (`src/governance/effectivePolicy.ts`)
  is called by BOTH runners at the per-step consult and by `patchwork policy
  explain <recipe> [tool]`. `effectivePolicy.test.ts` runs the real flat runner
  over a (profile × trigger × tool × opt-out) matrix and asserts the runner's
  consult/verdict equals the calculation's. Do not add a rule to one without
  the other — the test is what stops the explanation lying.
- **`patchwork doctor`** prints a governance section from runtime-effective
  state and ends `STATUS: GOVERNED` / `NOT GOVERNED` with reasons.
  `--require-governed` folds it into the exit code; without it the existing
  `doctor && echo deployed` contract is unchanged. `patchwork profile show` is
  the same report.
- **Kill switch is read through `readKillSwitch()` / `assertKillSwitchReleased()`**
  (`src/governance/killSwitchPolicy.ts`) at every chokepoint: recipe entry,
  webhook entry, `executeTool`, MCP `tools/call` for write-capable tools, and
  the orchestrator's pending→running transition. Never wrap
  `isWriteKillSwitchActive` in your own `try {} catch {}` — that is how four
  sites were fail-open with a comment saying "same as every other site".
- **Secrets are redacted by VALUE** (`src/governance/secretValues.ts`): env
  blocks, connector tokens, the bridge bearer and the secure store register
  their values in a memory-only registry; `captureForRunlog`, the approval
  queue, activity log, decision traces and the logger substitute
  `[REDACTED:<source>]` for the value and its URL-encoded / base64 /
  JSON-escaped forms. Orchestrator task prompts persist as sha256 + preview +
  AES-GCM ciphertext, never cleartext.
- **Outbound HTTP** has ONE guard (`validateOutboundUrl` / `safeFetch` in
  `src/ssrfGuard.ts`): lexical private-range refusal incl. unusual IPv4
  notations and IPv4-mapped IPv6, DNS resolve-once + pin, manual redirects
  re-validated per hop with credentials dropped cross-origin. `http.post` and
  `sendHttpRequest` both use it.
- **Known remaining bypasses are listed in the ADR.** Replay rebuilds the tier
  gate but not the worker gate (so a worker-owned recipe is REFUSED for replay under governed); the envelope does not reach `fan_out` items,
  nested child outputs or automation-hook prompts; `recipe test`/`record` are
  ungated; there is no prompt size cap.

## Workers / Autonomy Gate

The `src/workers/` subsystem implements a trust-ramp-aware autonomy gate for recipe-bound workers.

- **Worker identity**: a worker = a named recipe identity. Trust is per `(workerName × actionClassKey)` — never global. Competence demonstrated on reversible low-blast actions (reads, CI) cannot transfer to compensable or irreversible high-blast actions (git push, PR merge, file delete).
- **Trust levels**: L0–L4, Bayesian Beta posterior + LCB threshold. `outcomeWeight` is blast-weighted so one high-blast failure outweighs many trivial successes.
- **Three terminal states**: `allow` | `gate` | `forbid` (ADR-0017). `forbid` is not a stronger gate — it means no earned trust and no human approval unlocks the action. It is evaluated FIRST in `decideWorkerAction`, ahead of the agent-step carve-out, the reversibility short-circuit and all trust maths, because any branch that runs earlier is a path around it. Consequence taken deliberately: a broad rule can stall every worker on its agent step — a loud, self-explaining failure, chosen over the silent alternative of permitting a banned action.
- **Forbid rules**: `src/workers/forbidPolicy.ts`, passed via `AutonomyDecisionOpts.forbidRules`. Pattern language matches `WorkerManifest.owns` (domain | exact classKey | prefix). Empty/absent ⇒ nothing forbidden, so it is entirely opt-in. Unlike the roster, a malformed rule is NOT silently dropped — a deny-list that loses a rule fails *open*, so `parseForbidRules` reports what it could not parse.
- **Gate formula**: `effectiveLevel = min(earned, autonomyCeiling, contextCeiling)`, applied only to actions that are not forbidden.
- **Standing permissions** (`src/butler/standingPermission.ts`): a pre-recorded human approval, NOT earned trust. They are deliberately **not** part of the `min()` above — `decideWorkerAction` is byte-identical whether or not one exists. They compose one layer later in `resolveGateOutcome`, the single decision→action mapping shared by enforcement (`recipeOrchestration.ts`) and preview (`previewActions.ts`). Only a `queue` outcome is convertible to `flow`; `refuse` passes through, so no grant can unlock a forbidden action, and `coversAction` refuses `irreversible` outright. Folding a grant into the trust maths would make an action a human waved through in advance count as evidence the *worker* is reliable — trust-by-neglect. Every conversion writes an exercise row (`permission_exercises.jsonl`) and stamps `standingPermissionId` on the Decision Record, so `action: "gate"` WITH that id means "it went ahead and nobody was asked". The `contextCeiling` is a descending-only seam — signals can only lower autonomy, never raise it (NaN / out-of-range → no de-rate).
- **An unidentifiable action is not an approved one** (#1322): a non-reversible success that yields no join key is WITHHELD, not credited. The withhold branch is guarded on a key being present, so without this an unkeyable action fell through to `good: true` — the same fallthrough #1318/#1319 closed, in its last form, landing on the riskiest actions (`http.post` is `http:irreversible:medium`, brand-exposed). Scoped twice: NOT when no `OutcomeStore` is wired (a deployment state, not a property of the action), and NOT on the `strictOutcomeJoin: false` opt-out (which must reproduce historical labelling byte-for-byte). Paired with a one-level dip through a JSON `body` string in `deriveActionKey` — `body` only, one level only: it reads an id the service actually sent, never fabricates one, and every speculative extra field is another way to attach a human's confirmation to the wrong action. **Consequence for fixtures**: a worker can only climb the ramp on filings that are identifiable AND confirmed, so any test seeding an "earned" worker must emit `output: { url }` and confirm it, or it silently tests an unearned one.
- **Agent steps are not evidence** (#1320): `foldOutcome` withholds any step whose tool is `AGENT_STEP_TOOL` ("agent"), on success AND failure. The gate has always carved agent steps out as "not a gated action-class"; the fold did not mirror it, so the two disagreed and 50 unconfirmed agent successes folded as earned trust. Withheld both ways because a failed agent step reports on a model call, not on whether the worker can be trusted with a side effect. The literal lives in one place (`AGENT_STEP_TOOL` in `actionClass.ts`) because both sites hardcoding it independently is how they drifted. A guard test asserts no shipped worker owns the `other` catch-all domain — `agent` classifies `other:irreversible:medium`, and an `owns: other` entry would convert unconfirmed evidence into real trust silently.
- **Autonomy thresholds**: reversible actions bypass the gate unconditionally. Compensable actions unlock at effective L2. Irreversible actions require L4. None of these apply to a forbidden action.
- **Control boundary (prospective view)**: `previewActions(worker, candidates, store, opts)` in `src/workers/previewActions.ts` buckets candidate actions into *may do now / needs approval / not permitted* **before** anything is attempted. It calls `decideWorkerAction` and routes through `gateOutcomeFor` — it holds no policy of its own. That is load-bearing, not tidiness: a preview with its own logic would drift, and the failure is silent and permissive (a screen saying "not permitted" while the gate would allow it tells an operator they are protected when they are not). A test asserts preview and gate agree for every candidate under several rule sets. `defaultCandidatesFor(worker)` derives the default list from the worker's `owns` — deliberately not the whole tool registry, which would bury the few that matter and put all of them in "needs approval". Previewing is read-only: it never enqueues an approval and never writes a decision record.
- **Renderer**: `dashboard/src/components/ControlBoundary.tsx`, presentational only — it renders what the bridge computed and must never filter, re-bucket or infer, or the agreement guarantee dies. The third column differs from the second **in words** ("No approval can unlock these" vs "A named person must say yes"), not only colour, so the distinction survives greyscale and a colour-blind reader.
- **Out-of-package consumers import `patchwork-os/gate`** — a curated barrel (`src/gate.ts`) over the gate's public surface. It exists because the agreement guarantee stopped at the package boundary: `exports` listed only `.` and `./plugin`, and `.` is also `bin`, so importing the package root RUNS THE CLI rather than yielding a module. A consumer's only remaining option was re-deriving the three columns from `boundary_receipts.jsonl` and `worker_gate_decisions.jsonl` by hand — a second implementation of the boundary arrived at by the export map being narrower than the guarantee, not by anyone choosing one. It publishes nothing new (`files` already carried `dist` wholesale). **It must stay a pass-through**: `gateSubpathExport.test.ts` asserts reference identity against the source modules, because a wrapper with correct behaviour today passes every behavioural test and drifts next quarter. `patchwork-control-plane` is the first consumer.
- **Decision records**: every decision persists to `~/.patchwork/worker_gate_decisions.jsonl` with `gatePolicyVersion` (now `worker-ramp-v2`) and an optional `actor` — a *snapshot* (id + kind + display name as it was), never a roster reference, so a rename or role change cannot rewrite history. Absent on pre-attribution records and never backfilled: "nobody recorded this" must stay distinguishable from "we do not know".
- **Durable trust evidence**: `src/workers/trustCheckpoint.ts`. The dial used to live only in `runs.jsonl`, so a worker was silently un-earned whenever its runs rotated out — `WorkerLevelStore.toJSONL()` existed but nothing in production called it. `loadWorkerTrustForRecipe` now seeds from a per-recipe checkpoint under `<patchworkDir>/worker_trust/` and folds only runs the checkpoint has not absorbed. Per-recipe (not global) because that entry replays one recipe's runs, so a shared watermark would starve every other recipe. Only **settled** runs (older than the 24h durability window) are checkpointed: the fold is time-dependent, and persisting a provisional success would pin the watermark past a run that must be re-evaluated once it becomes durable. Fail-soft — missing/corrupt checkpoint ⇒ replay-only, the previous behaviour.
- **Feature flag**: `PATCHWORK_FLAG_WORKER_AUTONOMY` (default off). With the flag off, the gate is a no-op — byte-identical to pre-ramp behavior. Requires `--driver subprocess`.
- **Dogfood templates**: `templates/workers/` — three reference workers (release-notes, dependency-bump, triage-failing-tests).
- **Monitoring**: `patchwork workers shadow` replays logs and shows per-worker × action-class trust dial + ramp-vs-gate divergences. `patchwork workers backtest` calibrates cold-start without touching live gate behavior.
- **Full reference**: [docs/worker-autonomy-policy-gate.md](docs/worker-autonomy-policy-gate.md), [docs/runbooks/worker-autonomy-dogfood.md](docs/runbooks/worker-autonomy-dogfood.md).

## Information Boundary (ADR-0021)

`src/privacy/` — *what may this model be told?* The autonomy gate answers what a
worker may DO; this answers what a destination may RECEIVE.

- **Decision point is `executeAgent`** (`src/recipes/agentExecutor.ts`), evaluated
  before dispatch. **Do NOT bind this to `costRouter`** — that was tried and is
  recorded in the ADR as wrong: costRouter short-circuits with no downshift list
  and no USD cap, so the boundary would cover only budgeted steps while
  presenting as total enforcement.
- **Precedence `privacy → capability → cost`**, not negotiable by later stages.
  A cheaper or more capable model does not become authorised by being cheaper.
- **`approvable: true` on a remote destination is a DEAD KNOB on the recommended
  config shape**, and the claim that `REQUIRE_APPROVAL` is *unreachable* is
  WRONG — it was carried in handoff notes and repeated three times before anyone
  checked. It fires whenever no local destination accepts the classification.
  What is true is narrower and worse: rule 1 tests `LOCAL_ONLY` BEFORE
  `approvable`, so with a permissive local destination (which is what the
  reference machine runs) the flag can never fire, and the operator who asked to
  be asked is REFUSED instead — `LOCAL_ONLY` declines rather than rerouting.
  Reported by `patchwork privacy destinations`, deliberately NOT fixed by
  reordering: `narrowest()` ranks `REQUIRE_APPROVAL` stricter than `LOCAL_ONLY`
  while the runtime behaves the opposite way, so reordering makes live traffic
  newly approvable and needs a decision rather than a patch.
- **Five decisions**: `ALLOW` · `ALLOW_REDACTED` · `LOCAL_ONLY` ·
  `REQUIRE_APPROVAL` · `DENY`. Pure function of (declared classification,
  destination policy) — no model in the loop. `narrowest()` enforces never-widen.
- **Inert until opted in.** No `privacy` block ⇒ no destinations ⇒ no decisions.
  Registering a destination is the opt-in; once opted in it fails CLOSED.
- **`ALLOW_REDACTED` REFUSES, and field labels are DECLINED — [ADR-0024](docs/adr/0024-field-level-data-labels.md), 2026-08-30.** Not because the design is wrong: the shape is recorded there, including the point that makes it viable (removing a value the RENDERER placed is bookkeeping, not detection — `render()` is pure `{{key}}` substitution, so provenance is total at render time and gone one layer later). Declined because `ALLOW_REDACTED` has been returned **0 times in 254 recorded decisions**, so it would implement a branch that has never fired, and because its motivating population (58 undeclared steps) is now zero. **Trigger re-checked 2026-08-31: still 0, now of 264** (`ALLOW` 258, `LOCAL_ONLY` 6) — the decision stands, and the check is one `patchwork privacy receipts` away, so do it rather than assuming either direction. **Reopen on the ledger — a non-zero `ALLOW_REDACTED` count naming real operator recipes — never on the argument that redaction would be useful.** Purpose minimisation is declined separately, not by association: it asks about intent rather than provenance and does not follow from the design even if built.
- **`ALLOW_REDACTED` REFUSES, and that is CORRECT — not a stopgap.**
  `executeAgent` receives an already-rendered prompt, so removing a category
  there could only mean finding it in prose, i.e. DETECTION, which the ADR
  rejects as a boundary. Redaction and purpose both sit behind the same
  prerequisite: labels on the FIELDS a prompt is assembled from, applied at
  render time. That is a recipe-SCHEMA change, and it is NOT decided.
- **Receipts carry no payload field**, by construction: a privacy audit log
  containing the prompts would be the largest unclassified copy of exactly the
  material the boundary protects. Same rule for the shadow ledger.
- **Shadow mode** (`privacy.shadow`, a SEPARATE key from `privacy.destinations`
  so enabling shadow cannot enable enforcement). Observes LIVE — it does NOT
  replay, because a run-log `agent` step records no `data_policy`, no driver and
  no destination, so there is nothing to replay against.
- **Coverage is enumerated, never asserted as total.** `agent` steps were 54 of
  1,795 logged steps (~3%) when this was built. A crossing count over a partial
  surface reads as "your policy is fine" when it partly means "we did not look".
- **Orchestrator dispatch is now ENFORCED, on an operator opt-in** (2026-08-30
  amendment to ADR-0021; #1397 was the observe-only half). `privacy.orchestrator
  .classification` is a PATH-LEVEL default — its presence is the opt-in, and its
  absence leaves the path observed-but-ungoverned exactly as before, so no
  existing install changes behaviour by upgrading. A refused dispatch fails the
  task with `InformationBoundaryRefusal` (an `error` with a named cause, not a
  new lifecycle state).

  **`labelSource` has THREE values, and `default` is not a synonym for either
  other one.** `declared` = an operator classified THIS dispatch; `assumed` =
  nobody said anything and the runtime fell back to `internal`; `default` = an
  operator classified the CHANNEL. Folding `default` into `declared` asserts
  intent about a prompt no operator saw — the exact claim ADR-0021 refused to
  make, and the reason this path stayed ungoverned for two weeks. Folding it
  into `assumed` erases the only operator statement on the path.

  The choice of a path-level default over a per-task label was made from
  MEASUREMENT, as the ADR required: 10 orchestrator dispatches against 288
  recipe agent steps over 11 days. On ~3% of traffic an optional per-task label
  is a field nobody fills, and a mostly-empty declaration channel is worse than
  none because it looks like coverage.

  **`labelSource` is on the RECEIPT now, not only the shadow row.** It was
  observed-only from #1397, so the ENFORCING ledger could not distinguish an
  operator's label from the runtime's fallback — the receipt-shape precondition
  ADR-0021 set, unmet on the path that already enforced. Adding it meant three
  edits, not one: the writer type, the `record()` constructor copy, and the
  reader whitelist in `boundaryReceipts.ts`. That is the same trio `workspaceId`
  was dropped by (declared twice, copied nowhere) and `forbid` was dropped by on
  read (#1517).

  **A malformed `privacy.orchestrator.classification` fails OPEN** — deliberate,
  and asserted by a test so nobody quietly "fixes" it. Failing closed on a typo
  would refuse every orchestrator task on the machine, automation hooks
  included, with no hint of the cause in the symptom. A receipt that cannot be
  WRITTEN does not reopen the boundary: the record is wrapped, the refusal is
  outside the wrapper.

  **Observation runs BEFORE enforcement.** Reversed, every refused dispatch goes
  unobserved — dropping from the shadow report precisely the traffic a candidate
  policy is being evaluated against. `boundaryScope.test.ts` pins the order, and
  its first version did NOT: it compared the two function DECLARATIONS (which
  sit in the opposite order and never move) and passed against a deliberately
  swapped call site. Anchor a source-order guard on the CALL.
- **Open-core**: engine here (MIT); organisation policy inheritance, retention,
  signed evidence and curated industry policy packs are control-plane
  (ADR-0019). **Never add a policy pack or a real-world policy example here** —
  it ships MIT and cannot be withdrawn. Every privacy fixture stays synthetic.

## Workspace Identity

`src/identity/` — who may act in a workspace. Added because the bridge authenticated a single bearer token, so no persisted record could name a person and segregation of duties was *unenforceable*, not merely unimplemented.

- **Roles**: `owner` | `admin` | `operator` | `approver` | `auditor` | `worker`. A member holds a SET of roles, never one — otherwise a single-admin workspace must choose between administering and approving, and the workaround is to quietly give `admin` the approve capability. So `admin` gets policy/members/systems but NOT `action.approve`; `auditor` gets reads and nothing else.
- **Segregation of duties**: `canApproveAction(approver, preparedById)`. The self-approval check runs BEFORE the capability check — an owner holds `action.approve`, so testing capability first would report an owner approving their own work as allowed.
- **Roster**: `members.json` (honours `PATCHWORK_HOME`), loaded once at bridge startup into `server.roster`. Fail-SOFT: missing/unreadable/malformed ⇒ one implicit owner, byte-identical to pre-identity behaviour. This is deliberately the opposite of ADR-0016's fail-closed — that gate decides *whether an action happens* (safe default: no); this decides *who you are on your own machine* (safe default: the status quo ante).
- **Members are deactivated, never deleted** — deleting one would orphan every decision that names them.
- **Not yet wired to authorisation.** Nothing consults the roster to permit or refuse a request; it exists so a decision record has a real member to name. `canApproveAction` is referenced by nothing in production code — only its own module and tests.
- **What an UNATTRIBUTED (v1) session may do is DECIDED** — ADR-0020's 2026-08-25 amendment. Exactly what it does today, minus the actions that structurally require a named subject, which today means approving a gated action. Additive on purpose: nothing consults the roster for permission yet, so when enforcement lands no existing install starts failing, and the only new refusal is on a path that could never have been honestly attributed. Do NOT narrow a v1 session's powers generally — the single operator with a `DASHBOARD_PASSWORD` and no roster is the common case, and that would break a working workspace to fix a problem it does not have.
- **Attributing a gated decision to its approving human — ADR-0020 Phase A is BUILT AND WIRED, and the description that stood here is stale.** Durability was resolved first (ADR-0018 / #1245 + #1246 — `ApprovalQueue` persists via `src/approvalPersistence.ts`; timeouts risk-tiered since #1214, low 5 min / medium 1 h / high 4 h, so expiry was never the gap). Identity followed: `src/identity/{authSeam,credentialStore,dashboardSession}.ts` + `dashboard/src/lib/memberAuth.ts` + `dashboard/src/app/api/login/route.ts`. The dashboard cookie now has TWO forms (`dashboard/src/lib/session.ts:28-29`): `v2.<memberId>.<expiresAt>.<HMAC>` when a real member authenticates, `v1.<expiresAt>.<HMAC>` when only the shared secret does — so absence of a subject still means UNATTRIBUTED, never a defaulted person. **A request naming a `memberId` is answered ONLY by the identity seam; `DASHBOARD_PASSWORD` can never satisfy one.** The claim that the payload "is literally `` `v1.${expiresAt}` ``" was true before Phase A and is false now — it survived here long enough to mis-scope work, which is why it is called out rather than quietly deleted.

  **Where the approver is RECORDED — and where it used to go instead.** Resolving the identity was only half of Phase A. `approvalHttp` resolves the verified session *after* `queue.approve()` has already landed the decision (deliberate: identity must never block or alter an approval), and until #1527 the resolved name reached only the `approval_decision` audit hook, whose one production sink is `activityLog` — a best-effort log that ROTATES, halving itself when it grows. The single record of who approved a gated action was the single record allowed to discard its oldest rows. Meanwhile `approval_log.jsonl` (ADR-0018), the durable event source, had **no actor field at all**: 59 decision rows on the reference deployment (of 119 total, measured 2026-08-26), none able to name a person.

  Now a third append-only event kind — `attribution {callId, actor, attributedAt}` — is written to that same durable log, joined on `callId`. A **third event rather than a field on `decision`**, because the decision row is written before the approver exists: resolving first would invert the ordering and let the audit trail change the outcome it describes, and rewriting the row afterwards is the mutable store the log's own doc comment rules out. Absence stays absence — no verified session ⇒ no row, never an "unknown" and never the implicit owner. Existing rows are untouched and need no sentinel: `loadUnresolvedRequests` already ignores any kind that is neither `request` nor `decision`, and **must not** be turned into an exhaustive switch that throws, or a new event kind will strand a running bridge older than the rows it reads.

  **The reader already exists, one repo over.** `patchwork approvals` reads the *activity* log, not this one; `approval_log.jsonl`'s only in-repo reader is restart restore. Its consumer is the control plane's `approvalMeasures`, which filters strictly on `kind` — verified by deriving the same measures over a synthetic log with and without attribution rows and getting identical counts. That check could have failed: an earlier version of that function counted ROWS, and would have reported requests doubled.

  **Observed in production 2026-08-31 — and the claim that it was not is the thing this file got most wrong.** Attribution has fired end to end: `approval_log.jsonl` holds **5 `attribution` rows**, each naming a real `memberId` with `kind: "human"`, against **105 `decision` rows** — so coverage is 5 of 105, not zero. The text that stood here said the roster held one member with no credential, so no `v2` session could be minted and zero attribution rows existed anywhere. A credential was set; the path works. It survived long enough to be quoted in a project assessment as a live blocker, which is the specific cost of a stale measurement in this file: **re-measure before scoping, never quote this paragraph.** The trap for anyone measuring is unchanged and still catches people: **50 of 280** rows in `worker_gate_decisions.jsonl` carry a non-null actor and ALL of them are `kind: "worker"` — the autonomous-allow attribution, not an approver. `MemberKind` is `"human" | "worker"`; there is no `"member"`. A non-null check will tell you attribution works.

  **What is still true: authorisation is enforced NOWHERE.** `canApproveAction`, `capabilitiesFor`, `principalCan`, `roleGrants` have zero production call sites outside `src/identity/` and its tests. Six roles and eight capabilities currently grant nothing. The trap when that changes: the roster's fail-SOFT default (an implicit owner on a missing or malformed `members.json`) becomes privilege ESCALATION the moment anything consults it to permit an action. **Decided shape:** a pluggable auth seam resolving to `members.json`; Phase A per-member credentials via `crypto.scrypt` (no password-hash dep exists in the tree, and a native-compilation dep is a real cross-platform install risk here); Phase B OIDC mapped on `sub`, never `email` — **and Phase B is built in `patchwork-control-plane`, not here**: ADR-0019 reserves organisation identity (SSO/SCIM) for the non-MIT repo, the two ADRs were written in the same commit, and ADR-0020 originally cited ADR-0019 zero times. The SEAM and Phase A stay MIT here; federation does not. `src/identity/` as it stands is runtime and stays — the line is federation, not identity. The roster keeps its fail-SOFT default, and an unauthenticated principal stays UNATTRIBUTED. **Never default the actor to the implicit owner** — that writes a claim about a real person into an audit record on no evidence, which is worse than an absent `actor` (absence already means "nobody recorded this", and is never backfilled).

## Evidence Spine

> **Decided in [ADR-0025](docs/adr/0025-evidence-spine.md).** The principle lives
> there; this section carries the current measurements and the working notes.
> That split exists because this section's figures have gone stale three times —
> twice within 48 hours of being written — while the decisions behind them never
> moved. **Re-run `patchwork evidence` before scoping off any number below.**

**A design principle, not a subsystem.** Nothing here is a thing to go and build;
it is a constraint on how the things already being built should record what they
did. Its purpose is that six good subsystems converge instead of staying six
disconnected ledgers.

The rule: **every consequential operation should progressively become
attributable to a stable member, worker, policy, tool, model destination,
decision, approval and observed outcome.** A new feature is reviewed for whether
it strengthens, weakens or bypasses that chain.

**Do NOT build the readers ahead of the evidence.** A cross-ledger graph, a
replay/simulation surface, or a unified query UI built now would be a view over
data that does not exist yet, and the shape of the view would then dictate the
shape of the evidence — backwards. Preserve the evidence; the readers are cheap
once it is there and expensive to retrofit once it is wrong.

### What is actually true today

The ledgers are good and they mostly do not join. **One now does:**
`worker_gate_decisions.jsonl` carries `correlationId` (the run's `taskId`, never
`seq`) behind the `rv` sentinel, shipped as #1519 and deployed 2026-08-25.
Verified on the live ledger the same day: a new decision carries `rv:1` +
`correlationId`, and the 272 pre-existing rows hash byte-identical with no `rv`.

**Two now do.** `boundary_receipts.jsonl` joined the same way in #1522 — same
`rv` protocol, same rule (`taskId`, never `seq`), and covering BOTH runners, not
the easy half.

The rest still carry no shared correlation id: `privacy_shadow.jsonl`,
`outcome-log.jsonl`, `permission_exercises.jsonl` and `worker_trust/`. They
carry `workspaceId`, which is a tag and not a join key.

**`GraduationEvent` IS persisted, and the claim that it is not was wrong.**
`WorkerLevelStore.toJSONL()` serialises every event as `rec: "event"`,
`fromJSONL` restores them, and `saveTrustCheckpoint` calls `toJSONL()` — so the
per-recipe checkpoints under `worker_trust/` are its writer. What is true is
narrower and different: the only checkpoint on disk holds `meta:1, state:3` and
**zero** event rows, because nothing has ever graduated — no promote or demote
has fired, so there was no event to write. "No writer" and "a writer with
nothing to write" look identical on disk and are not the same problem; the first
is a hole to plumb, the second is a dial that has not moved.

Two corrections' worth of warning: this section was written from a survey, and
both of its load-bearing claims went stale or were wrong within two days. Re-run
the check before scoping against it.

**`patchwork evidence` is that check.** It reports, per ledger, how many rows
carry a `correlationId` out of how many rows exist, and how many runs appear in
more than one — the denominators, not a reader. Re-measured **2026-08-31** on
the reference machine: gate decisions **8 of 280**, boundary receipts **108 of
264**, `privacy_shadow` **0 of 309**, `outcome-log` **0 of 99**, `approval_log`
**0 of 215**, `butler/permission_exercises.jsonl` ABSENT. Runs reachable in BOTH
joined ledgers: **1**. The two populations barely overlap by construction — gate
rows are written for worker recipes under the autonomy flag, receipts for agent
steps with a registered destination — so the join is sparse rather than merely
young.

The figures five days earlier were gate **1 of 273**, receipts **14 of 170**,
shared runs **zero**. Receipts went 8% → 41% because the writer landed and has
been accruing since; the gate barely moved because its population barely moved.
Quote the direction, not either snapshot, and **re-run the verb** — this
paragraph has been stale twice already.

**`approval_log` at 0 of 215 is the one that matters commercially**, and it is
not merely another unjoined ledger. It is the ledger an outside auditor asks for
first ("who approved this, and under what rule"), and with no run reference no
run in the entire history can be assembled into that answer. Stamping it is the
smallest change that turns the spine from an internal property into something a
third party can check — the same `rv` protocol, already proven twice.

That zero is what keeps the evidence graph unbuilt, and it is why item 7 is not
"unblocked by the sentinel shipping": the sentinel settled HOW to stamp, and
there is still almost nothing stamped. The verb prints COUNTS ONLY — never a
row, an id or any value, because a `correlationId` is a run's `taskId` — so its
output is safe to quote where `runstore compare` and `privacy receipts` are not.

`ctxQueryTraces` reads four stores and none of those.

**How the second join was done, since the shape generalises.**
`boundary_receipts.jsonl` has ONE write site but FOUR dep-builders. Three sit
inside `runYamlRecipe` where `runTaskId` is already in scope; the fourth is
`buildChainedDeps`, called from `recipeOrchestration`, `replayRun` and
`commands/recipe` **before** `runChainedRecipe` computes the id. That was closed
with a cell created by `buildChainedDeps` and filled by the runner at the top of
the run — NOT by filling the field on the flat path only, which would have
repeated the `stepId` this same ledger once declared, never supplied, and
removed rather than wired. Expect the same ordering problem on any ledger
written from a dep-builder.

The reader mattered as much as the writer: `view()` in `boundaryReceipts.ts`
enumerates fields explicitly, so both new fields would have been dropped on read
— #1517's defect exactly, caught only because it was checked.

**The remaining three, measured 2026-08-25 rather than assumed. Read this before
scoping any of them.**

- `permission_exercises.jsonl` — **do not build a join for it yet.** The file is
  absent, and so is `butler/permissions.jsonl`: no standing permission has ever
  been granted, so there is nothing to correlate. Its absence is correct, not a
  bug. This is the "do NOT build the readers ahead of the evidence" rule with a
  concrete instance attached.
- `outcome-log.jsonl` — 99 rows, all keyed, none carrying a run reference. The
  hazard here is NOT plumbing, it is meaning: a disposition is recorded by a
  later run (or by an operator at a CLI) about an action performed by an
  *earlier* one, so a bare `correlationId` would be ambiguous between "the run
  that filed this action" and "the run that judged it". Two different facts
  under one field name is the kind of claim the `rv` protocol exists to prevent,
  so name it for what it is or leave it off. Note also that this ledger already
  has an `origin: "manual" | "ingester"` field distinguishing an operator's
  judgement from an automated one, and already defaults absence on read — a
  deliberate, documented departure from the gate ledger's never-backfill
  doctrine. Do not "fix" it to match without reading why.
- `worker_trust/` — checkpoints, i.e. derived state rather than an event stream.
  A correlation id belongs on the events folded into it, not on the snapshot.

### The constraint that makes this hard, and it is irreversible

`workerGateDecisionLog.ts` is doctrine: **absence is meaningful and is never
backfilled.** "Nobody recorded this" must stay distinguishable from "we do not
know". Stamping a correlation id onto new rows without first designing a
sentinel turns every existing row into a permanent orphan that a reader cannot
tell apart from a future row which legitimately had no run — two *different*
absences collapsing into one, silently, and the collapse cannot be undone.

So: **design the sentinel, then stamp.** Never the other way round, and never
"we can fix the old rows later" — that sentence is the bug.

### Working rules

- **Prefer deterministic, replayable inputs at every decision point.** Where a
  decision could be a pure function of recorded state, make it one. This is why
  `classifyIssueDisposition` has no LLM in it and why the privacy boundary is a
  pure function of (classification, destination). A decision that cannot be
  recomputed from what was written down cannot later be audited or replayed.
- **Shadow before enforce.** `privacy shadow` and `workers shadow` are the
  pattern: observe against real traffic, report the denominator, and only then
  turn a boundary on.
- **An unidentifiable action is not an approved one.** Evidence that cannot be
  joined to the thing it is evidence *of* must be withheld, never credited —
  see the strict outcome join in the workers section.
- **The ledgers stay open-format and fully usable standalone** (ADR-0019: the
  open runtime emits evidence, only the control plane attests to it). Evidence
  the operator cannot read and export without us is not evidence, it is
  hostage-taking.
- **Coverage is enumerated, never asserted as total.** A join that covers part
  of a surface must say which part; see the privacy section for why a crossing
  count over a partial surface reads as reassurance.

## Architecture Rules

- **Tools**: factory pattern `createXxxTool(deps)` returning `{ schema, handler }`. Register in `src/tools/index.ts`.
- **Extension handlers**: standalone async functions in `handlers` map. Register in `vscode-extension/src/handlers/index.ts`.
- **WebSocket safety**: all `ws.send()` calls must use `safeSend()` or readyState check + try-catch.
- **Extension dependency**: tools requiring extension must set `extensionRequired: true` in schema.
- **Tool names**: must match `/^[a-zA-Z0-9_]+$/`.
- **Error handling**: tool execution errors return `isError: true` in content (NOT JSON-RPC errors). JSON-RPC errors (`ErrorCodes`, -32xxx) for protocol issues only. See [ADR-0004](docs/adr/0004-tool-errors-as-content.md).
- **`extensionClient` shape validation**: `proxy<T>()` is blind TypeScript cast with no runtime validation — **do NOT use for new methods**. Eight latent shape-mismatch bugs (v2.25.18–v2.25.24) from this pattern. For new methods:
  - `tryRequest<T>(method, params, timeout, signal)` — auto-unwraps `{error}` / `{success: false, error}` to `null`. Use when success path is single T shape and caller doesn't need to distinguish error paths.
  - `validatedRequest<T>(method, params, validator)` — runtime shape predicate. Use when success path is object with specific required fields (e.g. `{items, count}` wrappers).
  - Direct `requestOrNull` + inline unwrap — when handler has rich contract (e.g. `{success: true/false, data, error}`) and caller needs structured error (see `closeTab`, `saveFile`). Do NOT use `tryRequest` — hides info caller needs.
  - When auditing: read handler in `vscode-extension/src/handlers/*.ts`, enumerate ALL return statements (success AND error paths) before choosing helper. Test mocks always lie — handler file is ground truth.
- **Automation DSL**: automation hooks compile to an `AutomationProgram` ADT (`src/fp/automationProgram.ts`) via `parsePolicy` (`src/fp/policyParser.ts`) and run through a single interpreter `executeAutomationPolicy` (`src/fp/automationInterpreter.ts`). Seven nodes: `Hook`, `Sequence`, `Parallel`, `WithCooldown`, `WithDedup`, `WithRateLimit`, `WithRetry`. Side effects isolated behind the `Backend` interface (`src/fp/interpreterContext.ts`): `VsCodeBackend` (prod) + `TestBackend` (collector with `reset()`). `AutomationHooks` holds one `AutomationState` value (`src/fp/automationState.ts`) — all state transitions go through pure functions. New hooks: extend `HookType` union, add parser case, wire handler to `_runInterpreter(hookType, eventData)`. Parallel branches merge via `mergeAutomationStates` (max timestamp per key).

## Packaging gate

`npm run audit:pack` (wired into `prepublishOnly`) refuses to publish any file
git does not track, `dist/` aside.

`package.json`'s `files` includes `templates` wholesale, and **git exclusions
have no effect on npm packaging** — `.git/info/exclude` is per-clone and
invisible to everyone else, and the `.npmignore` makes npm ignore `.gitignore`
entirely. So a file deliberately kept out of the repository is still packed.
Releases cut in CI are safe only because a fresh clone has no untracked files;
that is a property of the RUNNER, not of the package.

It is a gate rather than a denylist on purpose: `files` already carried
name-based exclusions for the private tool modules, which handled the compiled
side and missed the template side. It also **never prints filenames** — the
name of a deliberately-excluded file is itself the disclosure — reporting a
count and directory, with `--show` for a local listing. Same reasoning as the
private-identifier gate.

Deliberately NOT in CI: a clean clone can never fail it, and a check that
always reports OK is the noise that teaches people to ignore checks.

## Testing Requirements

- New tools: unit tests in `src/tools/__tests__/`
- New extension handlers: tests in `vscode-extension/src/__tests__/handlers/`
- Use vitest for both bridge and extension tests
- Coverage gates: 71% lines, 62% branches, 70% functions (see `vitest.config.ts`'s inline comment — re-baselined down from 75/70/75 for vitest 4's stricter AST-aware coverage counting; actual test coverage did not regress, only the measurement got stricter. Ratchet plan: nudge back up as margin allows — Windows/ubuntu CI currently clear ~72/63/71, so there's roughly 1pt of headroom already banked)
- Test circuit breaker and reconnect behavior for connection-related changes
- **CI matrix is all four cells again.** `windows-latest x Node 24` was excluded from #1369 and REINSTATED 2026-08-18 (#1447). Its cause was never vitest: libuv's `fs-event.c` asserts the filename it reports starts with the directory it was handed, and it reports the CANONICAL path — so an 8.3 short path (`RUNNER~1`, from `fs.mkdtempSync(os.tmpdir())`) ABORTED the shim process. An abort is not throwable, so the `try/catch` around `fs.watch` could not catch it. Fixed with `fs.realpathSync.native` before watching.
- **A killed CI step names what it was doing.** `scripts/vitest-progress-reporter.mjs` appends module start/end synchronously and is uploaded with `if: always()`. A missing `run-end` = the run was KILLED; `module-start` with no `module-end` = what was in flight. Every other reporter writes at the END, which is the moment a killed run never reaches.
- **`Coverage` is the TIGHT step, not `Test`** — measured across six windows/22 jobs: Test 4.7-5.0 min against a 10 min cap, Coverage 5.4-6.4 min against 8 min. Both historical `timeout-minutes` bumps were applied to the wrong one. Before raising either, read #1386: `sqliteRunStoreSpecifics.test.ts` is heavy-tailed on Windows (median ~16-18 s, max 304 s), so a ceiling that accommodates the tail lets three retries eat the whole step budget.
- **outputSchema is mandatory** for all tools. `scripts/audit-lsp-tools.mjs` enforces per-schema-block (not per-file) — multi-tool files can't mask gaps. Exceptions go in `scripts/audit-output-schema-allowlist.json` with a reason; ratchet gate rejects new entries and stale ones.

## Plugin System

Plugins register additional MCP tools without forking bridge. Run in-process alongside built-in tools.

- **Scaffold**: `claude-ide-bridge gen-plugin-stub <dir> --name "org/name" --prefix "myPrefix"` (add `--ts` for TypeScript variant — adds tsconfig + build/dev scripts; compiled artifact lands at `index.mjs` so the manifest entrypoint stays the same)
- **Load**: `--plugin <path-or-npm-package>` (repeatable). `--plugin-watch` enables hot reload.
- **Manifest**: `claude-ide-bridge-plugin.json` with `schemaVersion: 1`. Tool names must start with `toolNamePrefix` (2-20 chars, `/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`).
- **Entrypoint**: exports `register(ctx)` where `ctx` provides `workspace`, `workspaceFolders`, `config`, `logger`.
- **Distribution**: publish to npm with keyword `claude-ide-bridge-plugin`; install via package name.
- **Lifecycle**: loaded after CLI probes, before sessions accepted. On hot-reload, tools re-registered atomically.
- **No symlinks**: Files in `claude-ide-bridge-plugin/` are standalone copies, not symlinks. After modifying plugin source, manually sync copies — they will NOT auto-update.

Full reference: [documents/plugin-authoring.md](documents/plugin-authoring.md)

## OAuth 2.0 Mode

For remote deployments where claude.ai custom connectors need authenticated access.

- **Activation**: `--issuer-url <public-https-url>` activates OAuth 2.0. `--cors-origin <origin>` (repeatable) sets `Access-Control-Allow-Origin` on all responses.
- **Endpoints**: `/.well-known/oauth-authorization-server` (RFC 8414), `/.well-known/oauth-protected-resource` (RFC 9728), `/oauth/register` (RFC 7591 dynamic client registration), `/oauth/authorize` (approval page), `/oauth/token`, `/oauth/revoke` (RFC 7009).
- **Design**: PKCE S256 mandatory. Auth codes single-use, 5-min TTL. Access tokens opaque base64url, 24-hour TTL. No refresh tokens — clients connecting TO the bridge re-authorize on expiry. Note: connector tokens (bridge connecting OUT to external services) DO use refresh tokens and auto-refresh on 401 via `baseConnector.refreshToken()`.
- **CIMD**: if `client_id` is an `https://` URL, bridge fetches the Client ID Metadata Document (RFC draft) to discover `redirect_uris`; 5-min cache, 8 KB max, SSRF-guarded.
- **Bridge token**: resource owner credential. Entered in `/oauth/authorize` approval page. All string comparisons timing-safe.
- **CORS env var**: `CLAUDE_IDE_BRIDGE_CORS_ORIGINS=https://claude.ai,https://other.example.com` (comma-separated alternative to `--cors-origin`).
- **Never** commit bridge token, `--fixed-token` values, real domain names, `--issuer-url` values, or `--cors-origin` values to version control.

## Remote Deployment

- **VPS flags**: `--bind 0.0.0.0` exposes to all interfaces. `--vps` expands command allowlist (adds curl, systemctl, docker, etc.). `--fixed-token <uuid>` prevents token rotation on restart.
- **Headless (no IDE)**: `print-token [--port N]` retrieves auth token from lock file. CLI tools work; LSP/debugger tools require VS Code extension.
- **VS Code Remote-SSH / Cursor SSH**: extension has `extensionKind: ["workspace"]` — loads on VPS side automatically. Full tool support.
- **Reverse proxy**: required for remote access (nginx or Caddy with TLS). See [docs/remote-access.md](docs/remote-access.md).
- **Systemd + deploy scripts**: `deploy/bootstrap-new-vps.sh` (full provisioning), `deploy/install-vps-service.sh` (idempotent service install). See [deploy/README.md](deploy/README.md).
- **Scheduled task templates not auto-installed**: Copy from `templates/scheduled-tasks/` to `~/.claude/scheduled-tasks/` manually, then restart Claude Desktop.

## Claude Orchestration

Bridge spawns Claude Code subprocesses as background tasks.

- **Activation**: `--driver subprocess` (or `api`). Default `none` (disabled).
- **Tools**: `runClaudeTask` (enqueue prompt), `getClaudeTaskStatus`, `cancelClaudeTask`, `listClaudeTasks`, `resumeClaudeTask`.
- **Task lifecycle**: `pending` → `running` → `done | error | cancelled | interrupted`. Output streams to VS Code output channel, capped at 50KB.
- **Binary**: `--claude-binary <path>` overrides Claude CLI path (default: `claude` on PATH).

Full reference: [documents/platform-docs.md](documents/platform-docs.md) (Claude orchestration section).

## Automation Policy

Event-driven hooks that trigger Claude tasks automatically.

- **Activation**: Two paths:
  1. `--automation --automation-policy <path.json> --driver subprocess` — explicit policy file; hooks fire immediately and stay active for the bridge lifetime.
  2. Auto-enable (no `--automation` flag needed) — when `--driver` is non-none and at least one installed recipe declares a `file_watch`, `git_hook`, `on_file_save`, or `on_test_run` trigger, the bridge stands up a policy-less `AutomationHooks` at startup. **Startup-only**: installing a trigger recipe mid-session requires a bridge restart to take effect unless `--automation` is also active. `file_watch` and `git_hook` triggers hot-reload on recipe install/save/delete via `onRecipesChangedFn`; `on_file_save` and `on_test_run` are startup-only under the auto-enable path.
- **Hooks**:
  - `onDiagnosticsStateChange` (v2.43.0+) — unified diagnostics hook. `state: "error"` fires on new error/warning diagnostics (`{{file}}`, `{{diagnostics}}`, severity filter). `state: "cleared"` fires when errors/warnings drop to zero (`{{file}}`). Replaces deprecated `onDiagnosticsError` + `onDiagnosticsCleared`.
  - `onFileSave` — matching files saved. Minimatch glob patterns. Placeholder: `{{file}}`.
  - `onFileChanged` — matching files changed (buffer change, not save). Minimatch glob patterns. Placeholder: `{{file}}`.
  - `onRecipeSave` — fires when any `.yaml`/`.yml` file is saved. Placeholder: `{{file}}`. Default prompt (when no `prompt`/`promptName`) runs `patchwork recipe preflight {{file}}` and reports issues as a Claude task. Override with explicit prompt for custom behavior. Cooldown key: per-file, default 10 000 ms.
  - `onCompaction` (v2.43.0+) — unified hook. `phase: "pre"` fires before compaction (snapshot state); `phase: "post"` fires after (re-inject IDE state). Replaces the now-deprecated `onPreCompact` + `onPostCompact` pair; legacy names still work but emit a deprecation warning. Removed no earlier than 2026-09-01.
  - `onInstructionsLoaded` — fires at session start. Injects bridge status summary.
  - `onGitCommit` — fires after successful `gitCommit`. Placeholders: `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}`.
  - `onGitPull` — fires after successful `gitPull`. Placeholders: `{{remote}}`, `{{branch}}`.
  - `onGitPush` — fires after successful `gitPush`. Placeholders: `{{remote}}`, `{{branch}}`, `{{hash}}`.
  - `onBranchCheckout` — fires after successful `gitCheckout`. Placeholders: `{{branch}}`, `{{previousBranch}}`, `{{created}}`.
  - `onPullRequest` — fires after successful `githubCreatePR`. Placeholders: `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}`.
  - `onTestRun` — fires after `runTests` completes. **Caveat**: only fires when tests are invoked via the bridge `runTests` tool — bare `npm test` / `npx vitest` invocations do NOT trigger this hook. Placeholders: `{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}` (JSON array). Supports `filter: "any"|"failure"|"pass-after-fail"` (v2.43.0+). `"pass-after-fail"` replaces the deprecated separate `onTestPassAfterFailure` hook. Legacy `onFailureOnly` boolean still works but emits a deprecation warning.
  - `onTaskCreated` — fires on Claude Code TaskCreated hook (CC 2.1.84+). Placeholders: `{{taskId}}`, `{{prompt}}`.
  - `onTaskSuccess` — fires when orchestrator task completes successfully. Placeholders: `{{taskId}}`, `{{output}}`.
  - `onPermissionDenied` — fires on Claude Code PermissionDenied hook (CC 2.1.89+). Placeholders: `{{tool}}`, `{{reason}}`.
  - `onCwdChanged` — fires when Claude Code CWD changes (CC 2.1.83+). Placeholder: `{{cwd}}`.
  - `onDebugSession` (v2.43.0+) — unified debug-session hook. `phase: "start"` fires on session start (`{{sessionName}}`, `{{sessionType}}`, `{{breakpointCount}}`, `{{activeFile}}`). `phase: "end"` fires on termination (`{{sessionName}}`, `{{sessionType}}`). Replaces deprecated `onDebugSessionStart` + `onDebugSessionEnd`.
- **Shared options**: all hooks support inline `prompt` string or `promptName`/`promptArgs` named prompt references. All support `cooldownMs` (min 5000).
- **Cooldown**: min 5s between triggers for same file/event. Max prompt size: 32KB.
- **Webhook fan-out** (v1, `onCompaction` only — see [ADR-0009](docs/adr/0009-automation-webhook-fanout.md)) — any opted-in hook may add an optional `webhook: { url, method?, headers? }` config. When the hook fires, the interpreter POSTs (or PUT/PATCH) a JSON body to the URL AFTER the inline prompt enqueue. Body shape: `{ hookType, phase?, timestamp, ...eventData }`. 10s timeout; non-2xx and network errors are logged but never block other hooks. SSRF guard: loopback (127.0.0.0/8, ::1, localhost) and public hosts allowed; other private ranges blocked unless `--automation-allow-private-webhooks` is set. Both inline `prompt` AND `webhook` may be set on the same entry — they run sequentially: prompt first, then webhook. Hook entries with only a `webhook` (no `prompt` / `promptName`) are valid and skip the task enqueue. Example:
  ```json
  {
    "onCompaction": {
      "phase": "pre",
      "enabled": true,
      "cooldownMs": 5000,
      "webhook": {
        "url": "http://127.0.0.1:54321/hooks/compaction-snapshot-pre",
        "method": "POST",
        "headers": { "Content-Type": "application/json" }
      }
    }
  }
  ```
- **CC hook wiring** — hooks relying on Claude Code's hook system need MCP notify tools called from `settings.json`. Bridge registers these automatically when `--automation` active:

  | CC hook event | Shell command (settings.json) |
  |---|---|
  | `PreCompact` | `claude-ide-bridge notify PreCompact` |
  | `PostCompact` | `claude-ide-bridge notify PostCompact` |
  | `InstructionsLoaded` | `claude-ide-bridge notify InstructionsLoaded` |
  | `TaskCreated` | `claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT` |
  | `PermissionDenied` | `claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON` |
  | `CwdChanged` | `claude-ide-bridge notify CwdChanged --cwd $CWD` |

  `notify` subcommand reads bridge lock file, looks up running port and auth token, POSTs to `/notify` HTTP endpoint. Bridge must be running.

  Example `~/.claude/settings.json` block (Claude Code requires `matcher` + `hooks` arrays):
  ```json
  "hooks": {
    "PreCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PreCompact" }] }
    ],
    "PostCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PostCompact" }] }
    ],
    "InstructionsLoaded": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify InstructionsLoaded" }] }
    ],
    "TaskCreated": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT" }] }
    ],
    "PermissionDenied": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON" }] }
    ],
    "CwdChanged": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify CwdChanged --cwd $CWD" }] }
    ]
  }
  ```

## Transport & Session Model

| Transport | Client | Protocol |
|-----------|--------|----------|
| WebSocket | Claude Code CLI | `ws://127.0.0.1:<port>` with `x-claude-code-ide-authorization` header |
| stdio shim | Claude Desktop | stdin/stdout JSON-RPC, bridges to WebSocket internally |
| Streamable HTTP | Remote MCP clients (claude.ai, Codex CLI) | `POST/GET/DELETE /mcp` with Bearer token |

- **Trust evidence retention is a real constraint** (#1337). `runs.jsonl` is capped by BYTES; the durability window is defined in TIME. Nothing reconciles them, so a high-frequency recipe can starve the trust ledger — measured 18.2h retention against a 24h window, meaning a non-reversible success was deleted before it could settle and compensable/irreversible trust was unearnable *in principle*. Trust replay now reads `runs.jsonl.1` (the rotation archive) alongside the live file, deduped by `taskId` across both. `evidenceRetention()` reports span-vs-window and `workers shadow` warns when it goes negative — a starved ledger otherwise looks identical to a quiet worker. **The 18.2h figure is HISTORICAL, not current**: re-measured 2026-08-16 at **88h across 1129 rows against the same 24h window**, comfortably sufficient, with no rotation having fired since (`runs.jsonl.1` does not exist). The starvation was caused by one high-frequency recipe's volume, so this number tracks usage and can regress at any time — re-measure with `evidenceRetention()` before treating retention as a live problem rather than quoting either figure. **The durable fix is a filtered worker-run ledger** (worker rows are ~0.2% of volume, so noise-immune), deliberately not built yet: it spans 8 write paths where a miss is a silent evidence gap, and as of the latest measurement there is no live starvation forcing it.
- **Run log identity is `taskId`, NOT `seq`** (#1324). `seq` is a per-INSTANCE counter but `runs.jsonl` is shared by eight construction sites, several of which write — two live instances hand the same seq to unrelated runs (142 of 145 seqs collided in the live log). Deduping by it destroyed 2/3 of the run history, which is also the autonomy gate's trust evidence. `RecipeRunLog` now dedups on `taskId` at load AND upserts by it in `syncFromDisk` (the old `seq > this.seq` gate made a concurrent writer's runs invisible to a live bridge entirely). **Still open**: `getBySeq` backs `/runs/[seq]` and replay, so a run-detail page or a replay can still resolve to an arbitrary colliding run — fixing that is a URL-contract change. **Also open**: `rotateDisk` trims the oldest rows at the 1 MB cap. It is no longer true that nothing stands behind it — `worker_trust/` **has** been written since (a `butler-errand` checkpoint dated 2026-08-13 holding a watermark row plus three worker-state rows), so the `folded > 0` condition does now fire and the durable-checkpoint path is live rather than theoretical. Corrected 2026-08-16 by inspecting the directory; the previous claim that it had never been written was true when written and stale afterwards. Rotation destroyed the first real governed errand on 2026-08-11, which remains the reason the checkpoint exists.
- **Lock file**: `~/.claude/ide/<port>.lock` — `{pid, workspace, authToken, isBridge: true, ...}`. Created with `O_EXCL` (prevents symlink attacks), permissions `0o600`. `isBridge: true` distinguishes bridge locks from IDE-owned locks. See [ADR-0003](docs/adr/0003-isbridge-lock-file-flag.md).
- **Auth**: token from lock file, validated with `crypto.timingSafeEqual`. Host header DNS rebinding defense rejects non-loopback hosts.
- **HTTP sessions**: max 5 concurrent, 2hr idle TTL, oldest idle (>60s) evicted on capacity. See [ADR-0005](docs/adr/0005-http-session-eviction.md).
- **Session-hijack defense (OAuth mode)**: `verifyPrincipal` (`src/streamableHttp.ts`) binds an HTTP session to the SHA-256 hash of the bearer token presented at `initialize` — every subsequent POST/GET/DELETE must present a bearer that hashes to the same value, or 403. Replaces the old hard-required `Mcp-Session-Token` header (2026-07) — that header isn't part of the MCP spec, so standard clients (Gemini CLI, Codex, ChatGPT's connector) never sent it, making every OAuth-mode session unreachable by them. `Mcp-Session-Token` is still issued and optionally checked if present, but never required in any mode now.
- **Grace period**: `--grace-period <ms>` (default 120s) preserves session state across brief disconnects. Reconnecting client sending `X-Claude-Code-Session-Id` matching in-grace session is reattached (no new session, no re-initialization). stdio shim sends stable per-process UUID automatically.
- **Version numbers**: `BRIDGE_PROTOCOL_VERSION` (wire format, bump rarely) vs `PACKAGE_VERSION` (npm, every release). See [ADR-0001](docs/adr/0001-dual-version-numbers.md). Same dual-version applies to extension: `EXTENSION_PROTOCOL_VERSION` (wire compat, `"1.1.0"`) vs npm package version (`1.3.x`). `extension/hello` reports both — `protocolVersion` and `packageVersion`. Check both in bridge logs; `version=1.1.0` in logs is the wire version, not stale extension.
- **Generation guards**: every WebSocket callback checks `gen !== this.generation` to prevent stale callbacks corrupting new connection state. See [ADR-0002](docs/adr/0002-generation-guards-on-reconnect.md).

## Security Model

- **Command allowlist**: `runCommand` only executes allowlisted commands. Interpreter commands (node, python, bash, etc.) permanently blocked from `--allow-command`. Argument splitting prevents `--flag=value` injection.
- **SSRF defense** (`sendHttpRequest`): hostname blocklist for private/loopback ranges, DNS pre-resolution re-check, Host header override after user headers.
- **Path traversal** (`resolveFilePath` in `src/tools/utils.ts`): rejects null bytes, symlink escapes (ancestor chain walk), paths outside workspace.
- **Input validation**: AJV validates all tool arguments at transport layer before execution. `isValidRef` rejects leading-dash git refs. `searchAndReplace` rejects null bytes and `-`-prefixed globs. Clipboard enforces 1MB cap via `Buffer.byteLength`.
- **Rate limiting**: 200 requests/min (ring buffer), 500 notifications/min, per-session tool token bucket (default 60/min, configurable via `--tool-rate-limit`). Failed AJV validation does not consume rate limit tokens.
- **Error codes**: `ToolErrorCodes` (string codes in `isError: true` content blocks) for tool failures; `ErrorCodes` (JSON-RPC -32xxx) for protocol issues. Never mix. See [ADR-0004](docs/adr/0004-tool-errors-as-content.md).
- **Webhook HMAC auth** (`POST /hooks/*`): when started with `--webhook-secret <hex>` (or `BRIDGE_WEBHOOK_SECRET` env), requests carrying `X-Hub-Signature-256: sha256=<hex>` are authenticated via HMAC-SHA256 over the raw body (constant-time compare via `timingSafeEqual`). Bearer-token access still works — HMAC is additive. Without `--webhook-secret`, a request that presents `X-Hub-Signature-256` gets 401 `webhook_secret_not_configured` (must still pass Bearer gate to reach the handler); a missing/invalid signature with no Bearer returns 401 at the outer gate.

<!-- claude-ide-bridge:start:0.2.0-beta.13 -->
## Claude IDE Bridge
@import .claude/rules/bridge-tools.md
<!-- claude-ide-bridge:end -->

Bridge connected via MCP. Session-start hook reports connection status, tool count, and extension state automatically — check that summary before proceeding. If tools appear missing, call `getBridgeStatus` to diagnose.

> **MCP server name is `patchwork`** (project-level). Do NOT add a user-level `claude-ide-bridge` shim to `~/.claude.json` — it causes all bridge tool calls to stall. If you see `claude-ide-bridge · connecting…` in `/mcp`, remove it: `python3 -c "import json,pathlib; p=pathlib.Path('~/.claude.json').expanduser(); d=json.loads(p.read_text()); d['mcpServers'].pop('claude-ide-bridge',None); p.write_text(json.dumps(d,indent=2))"` then restart Claude Code.

### Bug fix methodology

When bug reported, do NOT fix first. Instead:
1. Write test that reproduces bug (must fail)
2. Fix bug, confirm test passes
3. Only then consider bug fixed

### Documentation & memory

- **After architectural changes** — update `CLAUDE.md` so future sessions have accurate context.
- **At end of work session** — save meaningful decisions to memory: *"Remember that we chose X approach because Y."*
- **Prune stale instructions** — remove/correct outdated guidance. Stale instructions cause confident mistakes.

### Modular rules (optional)

Move rules out of CLAUDE.md into scoped files under `.claude/rules/`:

```
.claude/rules/testing.md     — applies when working with test files
.claude/rules/security.md    — applies to auth, payments, sensitive modules
.claude/rules/typescript.md  — TypeScript-specific conventions
```

Reference from CLAUDE.md with:
```
@import .claude/rules/testing.md
```

Path globs on rule files mean Claude only loads them when working on matching files.

### Workflow rules

Bridge tool substitution rules in `.claude/rules/bridge-tools.md` (loaded above). Quick reference table below is summary.

Before starting non-trivial work (a new branch, anything touching shared subsystems), check [docs/in-flight.md](docs/in-flight.md) for work another session may already have in progress, and add an entry before you start.

### Quick reference

> Tools marked **[full]** are NOT available when the bridge was started with `--slim`. Full mode is the default (since v2.43.0); slim mode opts out to expose only IDE-exclusive tools (LSP, debugger, editor state). Call `getToolCapabilities` to confirm available tools.

| Task | Tool | Mode |
|---|---|---|
| Check errors / warnings | `getDiagnostics` | slim |
| Navigate to definition | `goToDefinition` | slim |
| Find all references | `findReferences` | slim |
| Call hierarchy | `getCallHierarchy` | slim |
| File symbols | `getDocumentSymbols` | slim |
| Interactive debug | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` | slim |
| Function signature at call site | `signatureHelp` | slim |
| Type hierarchy (supertypes/subtypes) | `getTypeHierarchy` | slim |
| Explain symbol (composite) | `explainSymbol` | slim |
| Inline type hints | `getInlayHints` | slim |
| Refactor safely | `refactorAnalyze` → `refactorPreview` → `renameSymbol` | slim |
| Extract function | `refactorExtractFunction` | slim |
| Bridge/extension health | `getBridgeStatus` | slim |
| Available tools? | `getToolCapabilities` | slim |
| Watch live diagnostics (long-poll) | `watchDiagnostics` | slim |
| Bundle editor context | `contextBundle` | slim |
| Stream recent activity events | `watchActivityLog` | slim |
| Screenshot | `captureScreenshot` | slim |
| List open editors | `getOpenEditors` | slim |
| Hover at cursor | `getHoverAtCursor` | slim |
| Go to declaration | `goToDeclaration` | slim |
| Go to type definition | `goToTypeDefinition` | slim |
| Find all implementations | `findImplementations` | slim |
| Batch find implementations | `batchFindImplementations` | slim |
| Selection range expand/shrink | `selectionRanges` | slim |
| Folding ranges | `foldingRanges` | slim |
| Preview code action | `previewCodeAction` | slim |
| Git status / diff | `getGitStatus`, `getGitDiff` | **[full]** |
| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` | **[full]** |
| Open pull request | `githubCreatePR` | **[full]** |
| File tree | `getFileTree` | **[full]** |
| Run shell command | `runInTerminal`, `getTerminalOutput` | **[full]** |
| Edit file by line range | `editText` | **[full]** |
| Open file in editor | `openFile` | **[full]** |
| Find + replace across workspace | `searchAndReplace` | **[full]** |
| List VS Code tasks | `listVSCodeTasks` | **[full]** |
| Run VS Code task | `runVSCodeTask` | **[full]** |
| Project info (name, version, deps) | `getProjectInfo` | **[full]** |
| Enqueue Claude subprocess task | `runClaudeTask` | **[full]** |
| List Claude subprocess tasks | `listClaudeTasks` | **[full]** |
| Checkout branch | `gitCheckout` | **[full]** |
| Pull from remote | `gitPull` | **[full]** |
| List branches | `gitListBranches` | **[full]** |
| Blame file | `gitBlame` | **[full]** |
| Run VS Code command by ID | `executeVSCodeCommand` | **[full]** |
| Cross-session context | `setHandoffNote` / `getHandoffNote` | **[full]** |
| Lint / format | `fixAllLintErrors`, `formatDocument` | **[full]** |
| Security audit | `getSecurityAdvisories`, `auditDependencies` | **[full]** |
| Unused code | `detectUnusedCode` | **[full]** |
| Coverage report | `getCodeCoverage` | **[full]** |
| Change-heavy files | `getGitHotspots` | **[full]** |
| Scaffold tests | `generateTests` | **[full]** |
| PR description | `getPRTemplate` | **[full]** |
| Unified task context (issue/PR/commit) | `ctxGetTaskContext` | **[full]** |
| Query past decisions (approval/enrichment/recipe/agent) | `ctxQueryTraces` | **[full]** |
| Record a fix for future sessions | `ctxSaveTrace` | **[full]** |
| Enrich commit with linked issues | `enrichCommit` | **[full]** |
| Reverse: commits that touched an issue | `getCommitsForIssue` | **[full]** |
| Stack frame → introducing commit | `enrichStackTrace` | **[full]** |

### Patchwork context platform — when to call what

The bridge has a built-in cross-session memory layer. **Prefer these over raw `gh` / `git` tools** for task-context lookups:

- **Starting a task?** Call `ctxGetTaskContext(ref)` first. Accepts any ref shape (`#42`, `PR-42`, commit SHA). Returns issue/PR/commit + linked commits + reverse issue links in one call. Fail-soft — missing `gh` / git shows up in `warnings`, never throws.
- **Fixing a bug?** Pair with `enrichStackTrace(stackTrace)` on the failing trace — maps frames to the commit that likely introduced the bug.
- **Done resolving?** Call `ctxSaveTrace(ref, problem, solution, tags?)` with a one-line problem + one-line solution. Future sessions see it via the session-start digest and `ctxQueryTraces`.
- **Debugging oversight?** `ctxQueryTraces({traceType, key, since, limit})` reads across all four stores (approvals, enrichment links, recipe runs, decision traces). The dashboard `/traces` page is the human UI over the same data.

On every session connect, the bridge prepends a digest of the last 12h of decisions to its MCP instructions block (top 5, ≤2 KB). If you see a `RECENT DECISIONS` section in your system prompt, that's live context — use it before re-running `gh`.

### Dispatch prompts (mobile)

Terse messages via Claude Desktop Dispatch (phone/Siri) are auto-routed to bridge prompts. Invoke directly by name in any chat. Keep responses under 20 lines for Dispatch.

> Require full mode (the default). Not available when the bridge was started with `--slim`.

| Phone message | Prompt | Tools called |
|---|---|---|
| "How's the build?" | `project-status` | `getGitStatus`, `getDiagnostics` |
| "Review my changes" | `quick-review` | `getGitStatus`, `getGitDiff`, `getDiagnostics` |
| "Does it build?" | `build-check` | `getProjectInfo`, `getDiagnostics`, `runCommand` |
| "What changed?" | `recent-activity` | `getGitLog`, `getGitStatus` |

### Agent Teams & Scheduled Tasks

| Context | Prompt | What it does |
|---|---|---|
| Team lead checking parallel agents | `team-status` | Workspace state, active tasks, recent activity across sessions |
| Scheduled nightly/hourly health check | `health-check` | Tests + diagnostics + security advisories + git status |

> `team-status` requires multiple Claude Code sessions connected simultaneously.

> **Claude Code ≥ v2.1.77**: `SendMessage` auto-resumes stopped agents.

Scheduled task templates (nightly-review, health-check, dependency-audit) included with bridge package. Copy to `~/.claude/scheduled-tasks/` and restart Claude Desktop. Find in `$(npm root -g)/claude-ide-bridge/templates/scheduled-tasks/`.

### Cowork (computer-use)

**MCP bridge tools NOT available inside Cowork.** Run `/mcp__bridge__cowork` in regular Claude Code or Desktop chat first to gather context and write handoff note, then open Cowork.

Workflow:
1. Regular chat: run `/mcp__bridge__cowork` → Claude collects IDE state → calls `setHandoffNote`
2. Open Cowork (Cmd+2 on Mac) → Cowork reads handoff note for context

**If bridge tools missing inside Cowork:** wrong context. Exit, run prompt in regular chat, return.

Full details: [docs/cowork.md](docs/cowork.md)

**Cowork uses git worktrees:** Cowork operates in isolated git worktree, not main workspace root. Files land in worktree. Always add "write all files to workspace root, not subdirectory" as first instruction in CLAUDE.md when using Cowork with synced workspace. After Cowork finishes, review and merge worktree branch back to main.

### Session continuity

| Scenario | Action |
|---|---|
| Switching CLI → Desktop | Call `setHandoffNote` before switching; bridge auto-snapshots if note >5 min stale |
| Session just started | Call `getHandoffNote` to pick up prior context (workspace-scoped). **Caution:** `onInstructionsLoaded` hook may have auto-overwritten note at session start — if content looks generic/templated, treat as stale and consult persistent session log (e.g. `docs/session-log.md`). |
| Bridge restarted | First connected client receives "restored from checkpoint" notification |
| Preparing for Cowork | Run `/mcp__bridge__cowork` in regular chat first — Cowork has no MCP access |
| Multi-workspace | Notes are workspace-scoped; switching workspaces won't overwrite each other's notes |
