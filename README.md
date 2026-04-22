# Patchwork OS

**AI that works while you're away. Runs on your machine. Doesn't lock you in.**

```bash
npx patchwork-os@alpha patchwork-init
```

That one command sets up 5 local recipes, detects Ollama, and drops a terminal dashboard at your fingertips — under 90 seconds on a warm npm cache.

## What it does

Patchwork OS watches for things that matter, acts, and asks before anything risky goes out.

- **A developer's overnight.** Tests fail on a push → a one-paragraph triage note lands in your inbox. You wake up knowing where to look.
- **A small business's inbox.** New customer questions triaged, follow-ups drafted in your voice. Nothing sends without your nod.
- **A parent's morning.** Field-trip form flagged, reply drafted to the teacher — done before the first coffee.

## How it works

- **Recipes** — plain YAML files describe what to watch and what to do. Share them like dotfiles. No code required.
- **Your models, your keys** — Claude, GPT, Gemini, Grok, or local Ollama. Swap anytime. Nothing phones home.
- **Oversight first** — everything risky lands in `~/.patchwork/inbox/` for your approval before it goes anywhere.

## After init

```bash
patchwork-os recipe list                    # see installed recipes
patchwork-os recipe run daily-status      # run one now
patchwork-os recipe run morning-brief --local  # run with local LLM
patchwork-os tools list                   # browse all 140+ tools
patchwork-os                              # open terminal dashboard
```

The oversight web UI runs at `http://localhost:3100` when the bridge is active. The dashboard shows live sessions, pending approvals, recent recipe runs, and analytics.

## Starter recipes (no external API keys needed)

| Recipe | Trigger | What it does |
|---|---|---|
| `ambient-journal` | git commit | appends one line to `~/.patchwork/journal/` |
| `daily-status` | cron 08:00 | morning brief from yesterday's commits |
| `watch-failing-tests` | test run | drops triage note to inbox on failure |
| `lint-on-save` | file save | surfaces new TS/JS diagnostics to inbox |
| `stale-branches` | cron weekly | lists branches older than 30 days |
| `morning-brief` | cron 08:00 | commits + Linear issues + Calendar events |
| `sentry-to-linear` | manual | Sentry issue → Linear ticket (one-shot) |

Local recipes write to `~/.patchwork/inbox/` only. Connectors (Linear, Sentry, etc.) require API keys and approval-gated writes.

## What's working today

| Feature | Status |
|---|---|
| `patchwork-init` — one-command setup | **shipped** |
| Terminal dashboard (`patchwork-os`) | **shipped** |
| Web oversight UI (approvals, sessions, recipes) | **shipped** |
| Recipe runner (YAML, cron, manual, webhook) | **shipped** |
| Multi-provider LLM (Claude, Gemini, OpenAI, Grok, Ollama) | **shipped** |
| Linear connector (read + approval-gated write) | **shipped** |
| Sentry connector (fetch issues, stack traces) | **shipped** |
| Google Calendar connector (read-only) | **shipped** |
| Slack connector (post messages, list channels) | **shipped** |
| 140+ MCP tools (LSP, git, tests, diagnostics) | **shipped** |
| Cross-session memory (traces, handoff notes) | **shipped** |
| Gmail connector | W2 |
| Mobile oversight PWA | W3 |
| Community recipe marketplace | Q3 |

## Install

**From the registry (recommended):**
```bash
npm install -g patchwork-os
patchwork-os patchwork-init
```

**From a local build (development / CI):**
```bash
git clone https://github.com/Oolab-labs/patchwork-os
cd patchwork-os
npm install && npm run build
# Use npm pack to create a real copy — do NOT use `npm install -g .`
# That creates a symlink which breaks the macOS LaunchAgent (EPERM at startup).
npm pack
npm install -g patchwork-os-*.tgz
patchwork-os patchwork-init
```

## License

MIT © Oolab Labs. Built on the [Claude IDE Bridge](./README.bridge.md).
