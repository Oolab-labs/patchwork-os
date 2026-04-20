# Starter Pack — 20 Recipes for the Rest of Your Life

Recipes are the connective tissue of Patchwork OS. This pack covers the
non-coder parts of daily life: the inbox, the calendar, the money, the
relationships, the self-observation that lives in the margins of notebooks.

Each recipe is a single YAML file with a trigger, steps, and an approval
surface. Nothing here sends or deletes without a human tap, except where
explicitly marked `risk: low` and reversible (appending to a log file, etc.).

Recipes that depend on unbuilt integrations are marked with a
`# requires: <mcp-name>` comment at the top. You can still read, fork, and
reason about them — they'll run once the integration lands.

## Install

```bash
patchwork recipe install examples/recipes/starter-pack/*.yaml
```

Or pick individual ones:

```bash
patchwork recipe install examples/recipes/starter-pack/sunday-reset.yaml
```

## The 20, by category

### Morning & Evening

| Recipe | What it does |
|---|---|
| `morning-brief.yaml` | 6am: weather + 3 meetings + 3 inbox items + yesterday's last note. One screen. |
| `evening-shutdown.yaml` | 6pm: recap today, capture open loops, set tomorrow's top-3, flip DND. |
| `sunday-reset.yaml` | Sunday evening: review the week, surface loose threads, propose next week's plan. |
| `quiet-hours-enforcer.yaml` | After 9pm, batch non-urgent notifications; real emergencies still ring through. |

### Inbox & Calendar

| Recipe | What it does |
|---|---|
| `calendar-defense.yaml` | Weekday 7am: flag conflicts, agendaless meetings, eroded deep-work, back-to-back stacks. |
| `meeting-prep.yaml` | 15 min before a meeting: prior thread + attendee context + one real question to ask. |
| `lost-thread-finder.yaml` | Friday 5pm: find conversations you promised to follow up on and dropped. |
| `travel-prep.yaml` | 48h before a trip: itinerary, weather-aware packing list, auto-reply, people to notify. |

### Money

| Recipe | What it does |
|---|---|
| `receipt-logger.yaml` | Passive: parses receipt emails, appends vendor/amount/category to a monthly ledger. |
| `subscription-watchdog.yaml` | Monthly: detect unused subs, price hikes, duplicates. Shows total burn, drafts cancels. |
| `errand-batcher.yaml` | Saturday morning: scrape "I need to..." mentions, group by location, route-order them. |

### Self-observation

| Recipe | What it does |
|---|---|
| `decision-journal.yaml` | Capture a decision with context/options/expected outcome; schedule 30/90-day reviews. |
| `mood-tagger.yaml` | 3x/day: one emoji, one line. Weekly pattern report correlated with calendar. |
| `reading-capture.yaml` | Collect Kindle/Readwise highlights, tag by theme, monthly synthesis file. |
| `social-battery-planner.yaml` | Sunday: score next week's events by social load; flag overcommit days. |

### Relationships

| Recipe | What it does |
|---|---|
| `apology-drafter.yaml` | On-demand: clean apology draft — name harm, own it, say what changes, stop. |
| `awkward-message-rewriter.yaml` | Paste a scary draft, get warmer/firmer versions + landmine flags before sending. |
| `disagreement-cooldown.yaml` | Heated draft? Hold 30 min, re-present with steelmanned opposing view + cooler rewrite. |
| `gift-brain.yaml` | Passively collect "she's into pottery" signals; surface 3 grounded gift ideas before dates. |
| `compliment-archive.yaml` | Silently archive real praise from messages/reviews to re-read on rough days. |
| `birthday-watcher.yaml` | 3 days out: draft a non-generic message tied to a real recent thing in that person's life. |

## What "approval" means here

Every recipe that writes, sends, cancels, or commits has an approval step —
typically `dashboard.render` with `approvals: true`. Patchwork shows the
proposed action on one screen. You tap once. Nothing leaves your machine
without that tap, except log-file appends (reversible) and internal state
updates (cached tags, etc.).

If a recipe fails, the default `on_error` is `log_only` — Patchwork does
not retry destructive actions. `quiet-hours-enforcer` specifically
fails-open: if the classifier breaks, notifications come through rather
than being silently dropped.

## Voice / tone matching

Several recipes (`apology-drafter`, `awkward-message-rewriter`,
`birthday-watcher`, etc.) read `~/.patchwork/voice-samples.md` for tone
matching. Put 3–5 of your own real messages there. Short, recent, varied.
The model's "in your voice" output is only as good as that file.

## Dependencies

Recipes marked with `# requires: <mcp>` need integrations not yet bundled:

- `gmail-mcp` — most inbox recipes
- `calendar-mcp` — most calendar recipes
- `contacts-mcp` — `birthday-watcher`, `gift-brain`
- `notes-mcp` — `sunday-reset`, `gift-brain`, `errand-batcher`, `reading-capture`
- `weather-mcp` — `morning-brief`, `travel-prep`
- `imessage-mcp` / `slack-mcp` — optional boosters for `compliment-archive`, `lost-thread-finder`

See `docs/integrations/` for status. Recipes degrade gracefully — steps that
need a missing MCP skip with a warning rather than crashing the run.
