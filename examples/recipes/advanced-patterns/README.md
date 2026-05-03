# Advanced Patterns — Chained & Multi-Agent Recipes

> **Vision tier.** These recipes demonstrate patterns that work today if you
> have the underlying integrations registered, or serve as design artifacts for
> what Patchwork should feel like once those integrations land. See
> [`../starter-pack/README.md`](../starter-pack/README.md) for the integration
> status legend.

Where the starter-pack covers single-step daily-life automation, this directory
covers the patterns that make Patchwork feel like a personal operating system:
multi-agent spawning, chained state files, mixed-model routing, and
accumulating trace logs that make the system smarter over time.

---

## The 6 recipes

### [`multi-agent-research.yaml`](multi-agent-research.yaml)

**The core pattern: spawn → parallel execute → synthesize.**

Give it a question. It decomposes into parallel research threads, spawns one
Claude subagent per thread via `runClaudeTask`, then merges all results into a
single structured document. The canonical reference for parent→child agent
topologies in Patchwork.

Requires: `--claude-driver subprocess` (or `api`), `file-mcp`, `notify-mcp`.

```bash
patchwork run multi-agent-research --question "What are the main failure modes of solo founder companies?"
```

---

### [`voice-memo-router.yaml`](voice-memo-router.yaml)

**Voice memo → transcription → right file, automatically.**

Watch a folder for dropped `.m4a`/`.mp3`/`.wav` files. Transcribe each one
with Whisper. Classify intent (project, person, task, idea, decision). Append
to the correct file in your projects or relationships folders. Archive the audio.

This is the recipe for everyone who has 47 voice memos they never processed.

Requires: `transcription-mcp` (Whisper), `file-mcp`, `notify-mcp`.

---

### [`mixed-provider-pipeline.yaml`](mixed-provider-pipeline.yaml)

**Route each step to the right model based on cost/capability.**

- Classification (fast + cheap) → `openai/gpt-4o-mini` or `claude-haiku-4-5`
- Bulk summarization (private + free) → `ollama/llama3.2` with fallback to Haiku
- Final synthesis (quality) → `anthropic/claude-sonnet-4-6`

The template for any batch workflow where not every step needs your best model.
Uses the `model:` and `model_fallback:` per-step fields.

---

### [`writer-feedback-loop.yaml`](writer-feedback-loop.yaml)

**Three parallel critics → one actionable feedback report.**

File-watch trigger on your drafts folder. On save, spawn three subagents:
hostile reader (quits at the first sign of padding), structural mentor (arc and
momentum), and naive first-timer (cold read confusion). Merge into a ranked
feedback report with per-action approvals. Each approval decision is logged to
`traces.jsonl` — over time, the system learns which lens you actually act on
per project type.

---

### [`relationship-memory.yaml`](relationship-memory.yaml)

**Per-person state files that accumulate from emails and meetings.**

Two recipes in one file:

1. **`relationship-memory`** — webhook trigger. POST a signal (email or meeting
   content + counterparty name), and the recipe extracts facts, open commitments,
   and "context for next time" into `~/relationships/{name}/state.md`.

2. **`relationship-stale-scan`** — Monday evening cron. Scans all relationship
   files, flags contacts marked "maintain" who've gone quiet >30 days, drafts
   re-engagement messages in your voice, presents for one-tap approval before
   sending.

---

### [`small-business-brain.yaml`](small-business-brain.yaml)

**Three interlocking recipes for solo operators.**

1. **`business-intake-router`** — webhook trigger. Drop any signal (email, voice,
   doc, note) into `/business-intake`, and the recipe classifies and routes it to
   the right file: `pipeline.md`, `finance/YYYY-MM.md`, `lessons.jsonl`, etc.

2. **`business-decision-brief`** — manual trigger. Before making a decision,
   surface relevant lessons and past similar decisions from your trace history.
   Builds institutional memory even when you're the only employee.

3. **`business-quarterly-review`** — quarterly cron. Reads all business files,
   synthesizes wins/losses/patterns, asks "what hypotheses about your business
   are you not currently testing?", writes a quarterly state-of-the-union.

---

## Common patterns used here

### Multi-agent spawn

```yaml
- id: spawn_agents
  parallel:
    each: "{{plan.threads}}"
    as: thread
    steps:
      - id: "agent_{{thread.id}}"
        tool: claude.runTask
        prompt: "{{thread.prompt}}"
        into: "result_{{thread.id}}"
```

Requires `--claude-driver subprocess` or `--claude-driver api`.

### Per-step model routing

```yaml
- id: classify
  model: openai/gpt-4o-mini
  model_fallback: anthropic/claude-haiku-4-5-20251001
  agent:
    prompt: "..."
```

### Accumulating trace log

Every approval decision writes to a `.jsonl` file:

```yaml
- id: log_decisions
  tool: file.append
  path: "{{TRACES_PATH}}"
  content: '{"ts":"{{ISO_NOW}}","approved":{{approved}},"skipped":{{skipped}}}'
```

Future runs read these traces to learn your preferences — which feedback you
acted on, which decisions you regret, which re-engagement messages you sent.

### File-watch with cooldown

```yaml
trigger:
  type: file_watch
  path: "{{DRAFTS_FOLDER}}"
  pattern: "*.md"
  event: saved
  cooldownMs: 30000   # don't fire on every keystroke
```

---

## Requires

| Recipe | Integrations needed |
|---|---|
| `multi-agent-research` | `claude-driver`, `file-mcp`, `notify-mcp` |
| `voice-memo-router` | `transcription-mcp`, `file-mcp`, `notify-mcp` |
| `mixed-provider-pipeline` | `file-mcp`, multi-provider model support |
| `writer-feedback-loop` | `claude-driver`, `file-mcp`, `dashboard-mcp`, `notify-mcp` |
| `relationship-memory` | `gmail-mcp`, `file-mcp`, `notify-mcp` |
| `small-business-brain` | `gmail-mcp`, `file-mcp`, `notify-mcp`, `scheduler-mcp` |

All recipes degrade gracefully — steps that need a missing MCP skip with a
warning rather than crashing the run.
