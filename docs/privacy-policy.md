# Privacy Policy — Claude IDE Bridge

**Last updated: March 2026**

Claude IDE Bridge ("the bridge") is an open-source MCP server that connects AI coding assistants to your editor. This policy describes what data the bridge handles, where it goes, and what we retain.

---

## What the bridge does

The bridge runs as a local process on your machine. It exposes a Model Context Protocol (MCP) server that your AI assistant connects to, and it communicates with your editor (VS Code, Windsurf, etc.) via a companion extension. When your AI assistant calls a bridge tool — for example to read a file, run a test, or search your codebase — the bridge relays that request to your editor and returns the result.

---

## Data handled by the bridge

The bridge processes the following categories of data **locally on your machine**:

| Category | Examples | Leaves your machine? |
|---|---|---|
| File paths and content | Source code, config files, .gitignore | Only if you use remote mode (see below) |
| Git metadata | Commit hashes, branch names, diff output | Only in remote mode |
| Terminal output | stdout/stderr from test runs and commands | Only in remote mode |
| Editor state | Open tabs, diagnostics, cursor position | Only in remote mode |
| Handoff notes | Short context strings written via `setHandoffNote` | Stored on disk only, never transmitted |
| OAuth tokens | Short-lived access tokens (1 hour TTL) | In-memory only, never persisted to disk |

**Local mode (default):** The bridge binds to `127.0.0.1` only. No data leaves your machine. Your AI assistant connects over localhost.

**Remote mode (VPS / reverse proxy):** When you start the bridge with `--bind 0.0.0.0` and expose it via a reverse proxy (nginx, Caddy), your editor data travels through that proxy to the remote client. You control the proxy — Anthropic does not operate any relay servers.

---

## What we do NOT do

- We do not collect telemetry, usage metrics, or crash reports.
- We do not transmit your code, file contents, or git history to Anthropic or any third party.
- We do not persist OAuth tokens or auth codes to disk — they live only in process memory and expire automatically (auth codes: 5 minutes, access tokens: 1 hour).
- We do not set cookies or use browser storage.
- We do not show ads or share data with advertisers.

---

## Data storage on disk

The bridge writes two categories of data to disk:

**Lock files** (`~/.claude/ide/<port>.lock`): Contain the bridge port number and auth token. Used to reconnect the editor extension after a restart. Readable only by the current user (mode `0600`).

**Handoff notes** (`~/.claude/ide/handoff-note.json`): A single small JSON file written when you call `setHandoffNote`. Contains only the string you provide. Not transmitted anywhere.

**Activity log** (`~/.claude/ide/activity-<port>.jsonl`): Tool call history in JSONL format. Rotated at 1 MB / 10K lines. Stays local — never transmitted.

**Session checkpoint** (`~/.claude/ide/checkpoint-<port>.json`): Tracks open files and terminal state for session restoration after bridge restart. Cleaned up on graceful shutdown.

---

## Third-party services

The bridge itself does not call any third-party APIs. Some tools (e.g. `sendHttpRequest`, GitHub CLI tools) make outbound HTTP calls on your behalf. Those calls go to the URLs you specify and are subject to those services' own privacy policies.

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

This policy may be updated when new features are added. Changes are tracked in the [CHANGELOG](https://github.com/Oolab-labs/claude-ide-bridge/blob/main/CHANGELOG.md) and the git history of this file.

---

## Contact

Questions or concerns: open an issue at [github.com/Oolab-labs/claude-ide-bridge](https://github.com/Oolab-labs/claude-ide-bridge/issues).
