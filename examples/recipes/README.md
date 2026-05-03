# Patchwork Recipes

Recipes are YAML files that describe a workflow Patchwork runs on your behalf — a trigger, some context, a sequence of steps (tools + agent prompts), and an error policy. They compile into the bridge's automation DSL. Drop one in `~/.patchwork/recipes/` and Patchwork picks it up on next reload.

## morning-inbox-triage.yaml

The hero recipe. Runs every morning at 4:30am while you sleep.

**What it does, in plain English:**

1. **Pulls your inbox** since the last run (up to 500 threads).
2. **Clusters** every thread into four buckets — Urgent, Reply, FYI, Trash — using your own `~/.patchwork/inbox-rules.md` as the rubric for "what matters to me."
3. **Summarizes** Urgent and Reply in under 400 words. One sentence per thread: who, what they want, what you should do.
4. **Drafts replies** in your voice for everything in the Reply bucket. Matches the tone of the prior thread. Does not send.
5. **Auto-archives** Trash (promos, expired receipts, dead notifications).
6. **Renders a dashboard** with approval buttons next to each draft and each urgent item.
7. **Pushes one notification** to your phone: *"6 need you. 4 drafts ready. 38 auto-archived."*

**What you see at 7am:**

Open the laptop. One screen. Maybe 6 items. Each has a one-line summary and an **Approve** button. Tap through them in 90 seconds. Drafts send. Urgents get snoozed to your calendar. Inbox is done before coffee.

No scrolling. No triage. No "I'll get to it later." The computer already did the boring part.

## Inbox provider notes

The `inbox.*` tools in this recipe are aspirational — they assume a Patchwork inbox plugin that speaks Gmail / IMAP / Outlook. The recipe structure (trigger → fetch → agent cluster → agent draft → tool archive → dashboard → push) is production-ready today; swap `inbox.fetch` for any data source (Slack, Linear, PagerDuty, Jira) and the same shape works.

## Try it

```bash
patchwork recipe install ./morning-inbox-triage.yaml
patchwork recipe run morning-inbox-triage   # dry-run, immediate
patchwork recipe enable morning-inbox-triage  # activates cron
```

## Subdirectories

| Directory | What's there |
|---|---|
| [`starter-pack/`](starter-pack/) | 20 personal-productivity recipes (morning brief, calendar defense, relationship care, etc.) |
| [`advanced-patterns/`](advanced-patterns/) | Multi-agent spawn, voice memo routing, mixed-model pipelines, writer feedback loop, relationship memory, small-business brain |
