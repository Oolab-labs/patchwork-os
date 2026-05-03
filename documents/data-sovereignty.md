# Data Sovereignty Guide

> For regulated professionals, privacy-conscious users, and anyone who
> needs to guarantee that their data, credentials, and AI outputs stay
> under their control.

This guide answers three questions:

1. What data does Patchwork OS write, and where?
2. How do you run without sending prompts to a cloud AI provider?
3. How do you export, back up, and audit everything?

---

## What data stays local

**Everything by default.**

Patchwork OS is a local-first runtime. No telemetry, no analytics, no
cloud sync. The bridge process runs on your machine and writes only to
your filesystem. The default model provider (Claude Code CLI) sends
prompts to Anthropic's API — but that is the one thing you can replace.

| Data | Location | Notes |
|------|----------|-------|
| Recipe run logs | `~/.patchwork/runs.jsonl` | Every recipe execution — trigger, steps, output |
| Approval decisions | `~/.patchwork/decision_traces.jsonl` | Every allow/deny on a tool call |
| Commit-issue links | `~/.patchwork/commit_issue_links.jsonl` | Enrichment results from `enrichCommit` |
| Activity log | `~/.claude/ide/activity-{port}.jsonl` | Tool calls, timing, session events |
| Auth token | `~/.claude/ide/{port}.lock` | Bridge session token — `0600`, never leaves disk |
| Connector credentials | `~/.patchwork/connectors/{name}.json` | OAuth tokens for external services |
| Plugin files | Your chosen `--plugin` paths | No auto-download; you install what you load |

None of these files are transmitted by the bridge. The only outbound
network calls the bridge makes are the ones you explicitly configure:
recipe webhook steps, `sendHttpRequest` tool calls, connector OAuth
flows. All are logged to the activity log as they happen.

---

## Running fully local (no cloud AI)

Patchwork supports **Ollama**, **LM Studio**, and any server that speaks
the OpenAI chat completions API — including local quantized models via
[vLLM](https://vllm.ai/) or [llama.cpp](https://github.com/ggerganov/llama.cpp).

### Option 1 — Ollama (recommended for local-only)

1. Install and start Ollama: `ollama serve`
2. Pull a model: `ollama pull llama3` (or `mistral`, `qwen2`, etc.)
3. Start the bridge with `--model local`:

```bash
claude-ide-bridge --full --model local
```

Patchwork auto-detects a running Ollama instance at
`http://localhost:11434` and uses it for all recipe and task execution.
No API key, no internet required.

To specify a different Ollama model or a custom endpoint, set it in
`~/.patchwork/config.json`:

```json
{
  "model": "local",
  "localEndpoint": "http://localhost:11434/v1/chat/completions",
  "localModel": "llama3:8b-instruct"
}
```

Then start the bridge normally:

```bash
claude-ide-bridge --full
```

Or override the model once without changing the config:

```bash
claude-ide-bridge --full --model local
```

### Option 2 — LM Studio

1. Start LM Studio's local server (default: `http://localhost:1234`)
2. Load your chosen model in LM Studio
3. Add to `~/.patchwork/config.json`:

```json
{
  "model": "local",
  "localEndpoint": "http://localhost:1234/v1/chat/completions"
}
```

### Option 3 — Any OpenAI-compatible endpoint

```json
{
  "model": "local",
  "localEndpoint": "https://your-vllm-server/v1/chat/completions",
  "localApiKey": "your-key-if-required"
}
```

### What "local-only" means in practice

With `--model local`:
- Recipe steps that call the AI go to your local endpoint
- The bridge itself never contacts Anthropic, OpenAI, or Google
- The VS Code extension, LSP tools, git tools, and webhook triggers all
  continue working — they don't require any AI provider
- Connector OAuth flows (Gmail, Linear, etc.) still contact those
  services' auth endpoints — that is inherent to using their APIs

---

## Credential storage

Connector credentials (OAuth access tokens and refresh tokens) are
stored in `~/.patchwork/connectors/{connector-name}.json` with mode
`0600` (owner read/write only).

What is stored:
- OAuth access token (short-lived, auto-refreshed)
- Refresh token (long-lived, used to get new access tokens)
- Token expiry timestamp

What is **not** stored:
- Your connector passwords
- The contents of emails, calendar events, or files fetched via connectors
- Any AI-generated output

To remove a connector's stored credentials:

```bash
rm ~/.patchwork/connectors/{connector-name}.json
```

The bridge will require re-authentication on next use.

For high-security environments, consider storing credentials in your OS
keychain and symlinking — or pointing `--patchwork-dir` to an encrypted
volume.

---

## The audit log

Every tool call the bridge executes is written to the activity log at
`~/.claude/ide/activity-{port}.jsonl`. Each line is a JSON record:

```jsonc
{
  "type": "tool_call",
  "ts": 1714900000000,
  "tool": "Bash",
  "specifier": "git status",
  "decision": "allow",            // allow | ask | deny
  "matchedRule": "Bash(git *)",   // which CC permission rule matched
  "ruleSource": "project",        // where the rule came from
  "durationMs": 42,
  "sessionId": "abc123"
}
```

The approval decision log at `~/.patchwork/decision_traces.jsonl`
records the same events with the human decision context:

```jsonc
{
  "traceType": "approval",
  "ts": 1714900000000,
  "key": "Bash/git push origin main",
  "summary": "allowed",
  "body": { "tool": "Bash", "specifier": "git push origin main", "decision": "allow" }
}
```

### Querying the audit log

```bash
# Show all denials in the last 24h
cat ~/.patchwork/decision_traces.jsonl \
  | jq 'select(.body.decision == "deny" and .ts > (now - 86400) * 1000)'

# Show all Bash calls today
cat ~/.claude/ide/activity-*.jsonl \
  | jq 'select(.tool == "Bash" and .ts > (now - 86400) * 1000) | .specifier'

# Count approvals by tool
cat ~/.patchwork/decision_traces.jsonl \
  | jq -r '.key' | cut -d/ -f1 | sort | uniq -c | sort -rn
```

### Dashboard audit view

The `/traces` dashboard page shows the full decision history with
filters by trace type, time range, key, and text. Every row links to the
recipe run or session that produced it.

---

## Exporting for compliance snapshots

The `patchwork traces export` command bundles all four log files into a
single auditable archive:

```bash
# Plain archive (gzip-compressed JSONL)
patchwork traces export

# Encrypted archive (AES-256-GCM, scrypt KDF)
patchwork traces export --passphrase "your-secure-phrase"
```

The encrypted `.enc` format uses:
- AES-256-GCM (authenticated encryption — detects tampering)
- scrypt key derivation (GPU-resistant brute-force protection)
- Random salt per export (unique key per file even with same passphrase)

Import on another machine:

```bash
patchwork traces import traces-export-2026-05-01.enc --passphrase "your-secure-phrase"
```

The dashboard **Export** button (on the `/traces` page) gives one-click
access to both plain and encrypted exports.

---

## Network isolation checklist

For environments where outbound network must be controlled:

| Component | Outbound connections | Disable / restrict |
|-----------|---------------------|--------------------|
| Bridge (core) | None | — |
| `--model local` (Ollama/LM Studio) | None | — |
| `--model claude` (default) | `api.anthropic.com` | Use `--model local` |
| `--model openai` | `api.openai.com` | Use `--model local` |
| `--model gemini` | Google API endpoints | Use `--model local` |
| Connector OAuth flows | Provider auth servers | Don't install connectors |
| `sendHttpRequest` tool | User-specified URLs | CC permission `deny` rule |
| `WebFetch` tool | User-specified URLs | `deny: ["WebFetch(*)"]` |
| Marketplace index | `raw.githubusercontent.com` | Block at firewall; works offline with local recipes |

Recommended policy for air-gapped or firewall-restricted environments:

```json
{
  "permissions": {
    "deny": [
      "WebFetch(*)",
      "Bash(curl *)",
      "Bash(wget *)"
    ]
  }
}
```

See [delegation-policy.md](delegation-policy.md) for the full rule
syntax and the `regulated-industry` profile.

---

## No-SaaS deployment checklist

Running Patchwork OS with zero cloud dependencies:

- [ ] `--model local` with Ollama or LM Studio
- [ ] No connectors installed (or only self-hosted connectors)
- [ ] `deny: ["WebFetch(*)", "Bash(curl *)", "Bash(wget *)"]` in `.claude/settings.json`
- [ ] Recipes stored in your local `~/.patchwork/recipes/` or a private git repo
- [ ] Trace exports encrypted with `patchwork traces export --passphrase <phrase>`
- [ ] Bridge token stored in system keychain or passed via `--fixed-token $(cat /run/secrets/bridge-token)`
- [ ] If VPS: reverse proxy with TLS, no public exposure of port 3100

For the full VPS + reverse proxy setup see
[remote-access.md](../docs/remote-access.md).
