# Patchwork OS — Install UX Plan

Status: proposal (not yet implemented). Owner: Foundation track.
Goal: collapse the 5–10 minute/5-step alpha install into **one command → first working agent in under 2 minutes**.

---

## 1. Current install flow audit

What a curious new user does today, reading `README.md` Quick Start:

| # | Step | Time | Friction |
|---|---|---|---|
| 1 | `git clone` the repo (README doesn't say this — user infers) | 20s | **F1** No `npm i -g` path advertised; package not published (`0.1.0-alpha.0`, status says "not yet published"). |
| 2 | `cd patchwork-os` | 2s | — |
| 3 | `npm install` | 45–90s | **F2** Pulls ~14 deps including full OTEL SDK (~50MB) the user doesn't need on first run. `postinstall.mjs` runs but only links `rg` — silent on failure. |
| 4 | `npm run build` | 10–20s | **F3** Requires TypeScript toolchain. `build` script wipes `dist/` then calls `tsc` + postinstall. A user who skipped this (ran `node dist/index.js` straight) gets "ENOENT dist/index.js". |
| 5 | `node dist/index.js --model claude --full` | — | **F4** `--model claude` isn't wired yet (Phase 0 in progress). Actually spawns the bridge, which expects an IDE / MCP client to connect. Nothing visible happens in the terminal. Appears hung. |
| 6 | User discovers they need `~/.patchwork/config.json` | 2–5 min | **F5** No config bootstrap. Schema exists (`config.schema.json`) but no `init` subcommand writes a starter config. |
| 7 | User needs to register MCP server with Claude Desktop OR launch a Claude Code session | 2–5 min | **F6** Manual edit of `~/Library/Application Support/Claude/claude_desktop_config.json`. `scripts/gen-claude-desktop-config.sh` exists but is undocumented in README. |
| 8 | User wants to see "the agent do a thing" | never | **F7** No preloaded recipes. No demo mode. No dashboard. Recipe system itself is *planned* (Phase 2). Nothing actually runs autonomously on a fresh install. |

**Net:** 7+ steps, 5–10 minutes, requires Node 20, TypeScript, a configured Claude client, and reading the schema file. The promised value ("AI that works while you're away") is invisible until the user has already invested ≥15 minutes.

**Dropoff estimate:** 90% at F4–F7 (nothing visibly happens after build).

---

## 2. Target flow — one command, <2 min to first working agent

### Options evaluated

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. `npx patchwork-os init`** | zero-install (just Node). Single command. Works everywhere Node 20+ runs. Familiar to dev audience. Easy to publish (already have `bin`). | requires Node 20 preinstalled. First run is slow (tarball download). | ★ **Recommend** |
| B. `curl -fsSL patchwork.sh \| sh` | Classic devtool UX (Homebrew, rustup, bun, deno). Can install Node if missing. | Security theater concerns. Harder to update. We'd ship a shell script that then downloads npm tarball — double indirection. |
| C. Homebrew tap (`brew install patchwork`) | Native on macOS/Linux. Handles Node dep. | Maintaining a tap for alpha is overkill. Windows excluded. Defer to v1.0. |
| D. Platform binaries via `pkg`/`bun build --compile` | True single binary. No Node needed. | ~60MB per platform. TS→binary toolchain not set up. Dashboard (planned Next.js) breaks this. Defer. |
| E. Docker image | Reproducible. | User has to learn docker flags, volume mounts for `~/.patchwork`. Loses "works on my machine" feel for non-devs. Keep as secondary (`docker run ghcr.io/oolab-labs/patchwork`). |

### Recommendation: **Option A — `npx patchwork-os init`**

Justification:
1. **Ships fastest.** We already have `bin.patchwork` in `package.json`. All that's missing is publishing to npm and implementing an `init` subcommand.
2. **Target audience has Node.** Phase-0/1 users are developers experimenting with MCP/Claude Code. Node-20 prerequisite is fair.
3. **Unblocks the demo.** `npx` fetches → runs → exits, so we can use it as the "first 5 minutes" driver without asking the user to install globally.
4. **Composable with later options.** A shell installer (B) or Homebrew tap (C) can wrap `npx patchwork-os init` later without rework.

**Target command:**
```bash
npx patchwork-os@latest init
```

What that one command does (each step visible, progress-logged, <90s total):
1. Detect Node ≥20; bail with a helpful message if older.
2. Write `~/.patchwork/config.json` (sane defaults, `provider: ollama-local` if Ollama detected; else stub with commented API keys).
3. Write 5 preloaded recipes to `~/.patchwork/recipes/` (see §3).
4. Write / merge `claude_desktop_config.json` so Claude Desktop sees the MCP server (skip with `--no-claude-desktop`).
5. Launch the bridge in the background, port auto-picked; print token + dashboard URL.
6. Print a 4-line "what now" block:
   - dashboard URL (`http://127.0.0.1:<port>/dashboard`)
   - `patchwork run daily-status` to execute a recipe now
   - `patchwork logs` to tail
   - `patchwork stop` to shut down

Success metric: median wall-clock from `npx patchwork-os init` → "I see Patchwork did something" under **120 seconds** on a warm npm cache.

---

## 3. First-run UX

On first launch, user must feel the product does something **without** configuring an API key. Strategy: **ship 5 recipes that run entirely on local signals.**

### 5 preloaded local-only recipes (no API keys required)

All 5 use the bridge's existing tools (git, filesystem, diagnostics, tests) and a local Ollama model if present, else fall back to rule-based templating (no LLM). Each is a YAML file the user can read, edit, or delete.

| # | Recipe | Trigger | What it does | Uses LLM? |
|---|---|---|---|---|
| 1 | **daily-status** | manual (`patchwork run`) | scans `~/` for git repos, summarizes dirty ones, unpushed commits, stale branches | optional (template fallback) |
| 2 | **watch-failing-tests** | `onTestRun` (filter: failure) | writes `~/.patchwork/inbox/failing-tests-<date>.md` with failures + suspected files (from `getGitHotspots`) | no |
| 3 | **lint-on-save** | `onFileSave **/*.{ts,js,py}` | runs workspace linter via `getDiagnostics`, drafts fix notes to inbox | no |
| 4 | **stale-branches** | cron (weekly) | lists local branches older than 30 days, drafts prune commands to inbox | no |
| 5 | **ambient-journal** | `onGitCommit` | appends one-line summary of commit to `~/.patchwork/journal.md` | optional |

Rule: **none of these send anything anywhere, ever.** They write to `~/.patchwork/inbox/`. User opens the dashboard, sees entries, approves or ignores. This keeps the oversight-first value prop front and center and avoids the "AI did a thing I didn't want" failure mode on first run.

### Terminal dashboard (MVP, pre-Next.js)

Until Phase 1 Next.js dashboard ships, give the user something immediately:

```
$ patchwork
Patchwork OS  v0.2.0   •   2 recipes active   •   port 6319

RECENT (last 1h)
  [14:03]  ambient-journal    wrote 1 entry          (committed: feat/dashboard)
  [14:01]  watch-failing-tests  3 failures in web/   → inbox/failing-tests-…

INBOX (3 pending approval)
  1. failing-tests-2026-04-18.md        ← patchwork open 1
  2. stale-branches-weekly.md           ← patchwork approve 2
  3. draft-reply-teacher.md             ← patchwork approve 3

PLANNED (next 10 min, local, no API calls)
  • daily-status scan of ~/src
  • ambient-journal on next commit

Connect one model to unlock more:
  patchwork connect claude           (best quality, needs API key)
  patchwork connect ollama           (free, local; auto-detected if running)

q to quit  •  r to refresh  •  o <n> to open inbox item
```

Single file, no framework. Implemented with ANSI + a poll loop reading `~/.patchwork/{activity.log,inbox/}`. Ships in the same PR as `init`.

### Nudge to connect one service

Appears once after the first successful recipe run. One prompt, two options, no modal stack:
```
Patchwork did 3 things locally. Connect Claude to get higher-quality drafts?
  [y] paste API key now        [n] later, show me again in 24h
```
Stored in config as `promptedConnectAt`. Max once/24h. Never blocks.

---

## 4. Onboarding sequence — first 5 minutes

| Minute | User does | User sees |
|---|---|---|
| **0:00** | Runs `npx patchwork-os@latest init` | "Checking Node… OK. Writing ~/.patchwork… Installing 5 starter recipes… Starting bridge on port 6319… Done." |
| **0:30** | — | Printed box: "Dashboard: http://127.0.0.1:6319/dashboard  •  Try: `patchwork run daily-status`" |
| **1:00** | Types `patchwork run daily-status` | Spinner for 3–5s. Then: "Scanned 7 git repos. 2 dirty, 1 unpushed. Wrote report → ~/.patchwork/inbox/daily-status-…md  •  Open with: patchwork open 1" |
| **1:30** | Types `patchwork open 1` | Report opens in `$PAGER` / `$EDITOR`. Real content about their repos. **First "it actually did something" moment.** |
| **2:30** | Returns to terminal, types `patchwork` | Terminal dashboard renders (see §3). "PLANNED" section shows `ambient-journal on next commit`. |
| **3:30** | Makes any git commit in a nearby repo | Within 2s, dashboard "RECENT" updates: `ambient-journal wrote 1 entry`. Second "wow" — user didn't ask for this, it just happened. |
| **4:30** | Sees connect nudge | Decides: connect Claude now (happy path) or dismiss. Either way, the agent stays useful. |
| **5:00** | — | User has: config, 5 recipes, 1 executed run, 1 autonomous trigger, a dashboard. Total install+onboard = 5 min. |

Every minute the user sees movement. No silent waits longer than ~5s. No "now edit this config file."

---

## 5. Next-steps punch list (5 tickets, each <1 day)

> All tickets scoped so a single engineer can land them in one working day with tests.

### T1 — Publish `patchwork-os@0.2.0-alpha` to npm *(blocker for everything else)*
- Bump `version` to `0.2.0-alpha.0`.
- `npm publish --access public --tag alpha`.
- Verify `npx patchwork-os@alpha --help` works on a clean machine.
- Add `.github/workflows/publish-npm.yml` gated on `v*-alpha*` tags.
- **Done when:** `npx patchwork-os@alpha --version` prints `0.2.0-alpha.0` on a machine that has never seen the repo.

### T2 — Implement `patchwork init` subcommand
- New file `src/commands/init.ts`. Wire into CLI dispatcher.
- Writes `~/.patchwork/config.json` (merge, don't clobber) from `config.schema.json` defaults.
- Copies `templates/recipes/*.yaml` (ships in package) to `~/.patchwork/recipes/`.
- Detects Ollama (`curl -s localhost:11434/api/tags`) → sets `provider: ollama-local` if up.
- Optional flag `--no-claude-desktop` to skip the `claude_desktop_config.json` merge.
- Prints the 4-line "what now" block.
- **Done when:** `npx patchwork-os init` on a blank machine produces a runnable setup in <90s.

### T3 — Ship 5 local-only recipe templates + recipe runner MVP
- `templates/recipes/{daily-status,watch-failing-tests,lint-on-save,stale-branches,ambient-journal}.yaml`.
- Minimal YAML recipe parser → existing automation DSL (`src/fp/policyParser.ts` already accepts hooks; add a YAML layer that compiles to that shape). Do **not** block on the full Phase-2 recipe system; parse a tiny subset (trigger, tools, output-path).
- `patchwork run <recipe>` executes manually. `patchwork list` enumerates.
- All 5 recipes have unit tests using `TestBackend`.
- **Done when:** each of the 5 recipes runs end-to-end against a scratch workspace and writes to inbox.

### T4 — Terminal dashboard (`patchwork` with no args)
- `src/commands/dashboard.ts` — tty renderer, poll `~/.patchwork/activity.log` + `inbox/`.
- Keybindings: `q` quit, `r` refresh, `o <n>` open inbox item in `$EDITOR`, `a <n>` approve (moves to `~/.patchwork/approved/`).
- Graceful fallback to plain `console.log` if `process.stdout.isTTY === false`.
- **Done when:** running `patchwork` shows recent activity + inbox + planned sections and updates when a recipe fires.

### T5 — Readme + `connect` nudge
- Rewrite README Quick Start to **one line**: `npx patchwork-os@alpha init`.
- Move the current `npm install && npm run build` path under a "From source" collapsible.
- Implement `patchwork connect <provider>` — interactive prompt, writes key to config, 0o600 perms.
- Wire the 24h nudge into the dashboard (one line only, no modal).
- Add a 15-second asciinema recording of the `init → run → open` flow at the top of README.
- **Done when:** README top-of-fold shows one command, one gif, one paragraph of value prop. No build steps visible.

---

**Sequencing:** T1 → T2 → T3 can land in parallel after T1 ships. T4 depends on T3 (needs activity.log format). T5 depends on T2+T4. Target: all five merged within one sprint (2 weeks) to hit the 5-minute-wow bar before broader alpha announcement.
