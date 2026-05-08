# Privacy Policy — Patchwork OS / Claude IDE Bridge

**Last updated: May 2026**

Patchwork OS (also distributed as Claude IDE Bridge — "the bridge") is an open-source MCP server that connects AI coding assistants to your editor. This policy describes what data the bridge handles, where it goes, and what we retain.

---

## What the bridge does

The bridge runs as a local process on your machine. It exposes a Model Context Protocol (MCP) server that your AI assistant connects to, and it communicates with your editor (VS Code, Windsurf, etc.) via a companion extension. When your AI assistant calls a bridge tool — for example to read a file, run a test, or search your codebase — the bridge relays that request to your editor and returns the result.

---

## Data the bridge processes

The bridge processes the following categories of data **locally on your machine**:

| Category | Examples | Leaves your machine? |
|---|---|---|
| File paths and content | Source code, config files, .gitignore | Only if you use remote mode (see below) |
| Git metadata | Commit hashes, branch names, diff output | Only in remote mode |
| Terminal output | stdout/stderr from test runs and commands | Only in remote mode |
| Editor state | Open tabs, diagnostics, cursor position | Only in remote mode |
| Handoff notes | Short context strings written via `setHandoffNote` | Stored on disk only, never transmitted |
| OAuth tokens | Short-lived access tokens (24-hour TTL) | In-memory only, never persisted to disk |

**Local mode (default):** The bridge binds to `127.0.0.1` only. No editor data leaves your machine via the bridge itself. Your AI assistant connects over localhost.

**Remote mode (VPS / reverse proxy):** When you start the bridge with `--bind 0.0.0.0` and expose it via a reverse proxy (nginx, Caddy), your editor data travels through that proxy to the remote client. You control the proxy — Anthropic does not operate any relay servers.

---

## Data stored on disk

The bridge writes the following files in your home directory. All are **local-only** unless you enable opt-in analytics (see below).

| File | Contents | Rotation |
|---|---|---|
| `~/.claude/ide/<port>.lock` | Bridge port number and auth token, used for editor-extension reconnect. Mode `0600`. | Cleaned up on shutdown. |
| `~/.claude/ide/handoff-note.json` | Single string written by `setHandoffNote`. | Overwritten on each call. |
| `~/.claude/ide/checkpoint-<port>.json` | Open files / terminal state for session restoration. | Cleaned up on graceful shutdown. |
| `~/.claude/ide/activity-<port>.jsonl` | Tool-call history: tool name, duration, success/error. **No arguments, no output.** | Rotated at 1 MB / 10K lines. |
| `~/.claude/ide/analytics.json` | Your opt-in preference (boolean + decision timestamp). Mode `0600`. | Persistent. |
| `~/.claude/ide/analytics-salt` | Random per-install salt used to hash plugin tool names. Mode `0600`. | Persistent; never transmitted. |
| `~/.patchwork/runs.jsonl` | Recipe execution history: recipe name, trigger, status, duration, per-step results, output tail (≤2 KB), assertion failures. | Rotated at 1 MB / 10K lines. |
| `~/.patchwork/decision_traces.jsonl` | Problem/solution traces written by agents via `ctxSaveTrace`. | Rotated at 1 MB / 10K lines. |
| `~/.patchwork/commit_issue_links.jsonl` | Commit ↔ issue links extracted by `enrichCommit`. | Rotated at 1 MB / 10K lines. |
| `~/.patchwork/telemetry.json` | First-run timestamp, total recipe runs, 14-day rolling counts. **No event details, no recipe contents.** | Persistent. |
| `~/.patchwork/inbox/` | Recipe outputs you've explicitly chosen to write here (e.g. `morning-brief-<date>.md`). | You manage these. |

`~/.patchwork/` respects the `PATCHWORK_HOME` environment variable.

These files are **never transmitted by the bridge** unless you opt in to analytics. They exist so that decisions, recipe runs, and tool history persist across bridge restarts and sessions.

---

## Opt-in usage analytics

The bridge ships with an **opt-in** anonymized analytics pipeline. It is **off by default** — the bridge does not send anything until you explicitly enable it.

**How to enable / disable:**

```bash
claude-ide-bridge --analytics on    # opt in
claude-ide-bridge --analytics off   # opt out
claude-ide-bridge --analytics       # show current preference
```

Your preference is stored in `~/.claude/ide/analytics.json` (mode `0600`).

**What is sent (when opted in):**

At the end of each session, a single anonymized summary is POSTed to `https://analytics.claude-ide-bridge.dev/v1/usage`:

- Bridge version (e.g. `0.2.0-beta.0`)
- Session duration in milliseconds
- Per-tool counts: `{tool: string, calls: number, errors: number, p50Ms: number, p95Ms: number}`
  - **Built-in tool names** (a fixed allowlist — `getDiagnostics`, `readFile`, `runCommand`, etc.) are sent verbatim
  - **Plugin tool names** are hashed with a per-install random salt and reduced to an 8-character hex prefix (e.g. `plugin:a1b2c3d4`). The salt is generated locally on first send and never transmitted; the same plugin produces a different hash on a different machine, so plugin usage cannot be correlated across installs.

**What is NOT sent — ever:**

- File paths (workspace, source files, anything containing your username)
- File contents, diffs, or terminal output
- Tool arguments or return values
- Error messages or stack traces
- Commit hashes, branch names, commit messages, remote URLs
- Recipe names, recipe contents, prompt text, AI-generated YAML
- Issue / PR titles, ticket text
- OAuth tokens, auth tokens, handoff notes, decision traces
- IP address (beyond what the HTTP transport implicitly carries; we do not log or retain it)
- Any user-identifying metadata: name, email, machine name, geographic info

The send is best-effort with a 3-second timeout. All errors are silently swallowed — analytics failures never affect bridge operation. If you opt out (or never opt in), no network call is made.

---

## Optional OpenTelemetry export

The bridge can export OpenTelemetry traces for self-hosted observability. This is **off by default** and only activates when you set the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable.

When configured, span data goes only to the endpoint **you configure** (e.g. your own Jaeger / Honeycomb / Datadog instance). Anthropic does not receive these traces.

---

## What we do NOT do

- We do not transmit your code, file contents, terminal output, or git history to Anthropic or any third party.
- We do not collect crash reports automatically. Errors are written to stderr only.
- We do not persist OAuth tokens or auth codes to disk — they live only in process memory and expire automatically (auth codes: 5 minutes, access tokens: 24 hours).
- We do not set cookies or use browser storage.
- We do not show ads or share data with advertisers.
- We do not build cross-install user profiles. The opt-in usage summary contains no stable user identifier.

---

## Third-party services

The bridge itself does not call third-party APIs unless you direct it to. Tools like `sendHttpRequest`, `gh` GitHub commands, Linear/Sentry/Slack connectors, and Gmail/Google Calendar integrations make outbound calls **on your behalf, to the URLs and services you specify**. Those calls are subject to those services' own privacy policies. The bridge holds the OAuth tokens for those connectors only in memory or in connector-specific token stores you configure.

---

## Remote access and OAuth

When you enable OAuth (`--issuer-url`), the bridge runs a minimal OAuth 2.0 authorization server. This:

- Issues short-lived access tokens to MCP clients that complete the authorization code + PKCE flow.
- Does not store any user account data — the only "account" is your bridge token.
- Does not contact any identity provider.

---

## Children's privacy

The bridge is a developer tool not directed at children under 13 (or the applicable age in your jurisdiction). We do not knowingly collect personal information from children.

---

## Changes to this policy

This policy may be updated when new features are added or when the data-handling model changes. Material changes are tracked in the [CHANGELOG](https://github.com/Oolab-labs/claude-ide-bridge/blob/main/CHANGELOG.md) and the git history of this file.

---

## Contact

Questions or concerns: open an issue at [github.com/Oolab-labs/claude-ide-bridge](https://github.com/Oolab-labs/claude-ide-bridge/issues).
