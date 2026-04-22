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
patchwork-os recipe list            # see installed recipes
patchwork-os recipe run daily-status  # run one now
patchwork-os                        # open terminal dashboard
```

The oversight web UI runs at `http://localhost:3100` when the bridge is active.

## 5 starter recipes (no API key needed)

| Recipe | Trigger | What it does |
|---|---|---|
| `ambient-journal` | git commit | appends one line to `~/.patchwork/journal/` |
| `daily-status` | cron 08:00 | morning brief from yesterday's commits |
| `watch-failing-tests` | test run | drops triage note to inbox on failure |
| `lint-on-save` | file save | surfaces new TS/JS diagnostics to inbox |
| `stale-branches` | cron weekly | lists branches older than 30 days |

All 5 write to `~/.patchwork/inbox/` only. Nothing is sent anywhere without your approval.

## Roadmap

| Phase | Status |
|---|---|
| Foundation — init, recipes, terminal dashboard | **shipped (W1)** |
| Connectors — Gmail, calendar, Slack | W2 |
| Mobile oversight — approve from phone | W3 |
| Community recipes + ecosystem | Q3 |

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
