# Delegation Policy

> Define what AI may do, what needs approval, and what is forbidden.

Patchwork enforces a three-tier permission model inherited from Claude Code's
settings system. Every tool call is classified before execution:

| Tier | Meaning |
|------|---------|
| **allow** | Execute without interrupting the user |
| **ask** | Pause and wait for human approval |
| **deny** | Block unconditionally — no override |

Precedence: `deny` at any level beats everything. `ask` beats `allow`.
Any `allow` match grants.

---

## Where settings live

Patchwork reads Claude Code's standard settings files in this order
(highest precedence first):

| File | Scope | Notes |
|------|-------|-------|
| Managed settings | Platform | Set by admins; cannot be overridden |
| `.claude/settings.local.json` | Project (local only) | Not committed to VCS |
| `.claude/settings.json` | Project (shared) | Committed — team-wide defaults |
| `~/.claude/settings.json` | User | Your personal baseline |

Rules from all matching files are merged. A `deny` in any file wins.

---

## Policy syntax

Settings files use the `permissions` key:

```json
{
  "permissions": {
    "allow": ["Read", "Bash(git status)", "Bash(npm run *)"],
    "ask":   ["Bash(git push *)", "Edit"],
    "deny":  ["Bash(rm -rf *)", "Bash(sudo *)"]
  }
}
```

### Rule forms

| Pattern | Matches |
|---------|---------|
| `Read` | The `Read` tool with any or no specifier |
| `Bash(git status)` | `Bash` with specifier exactly `git status` |
| `Bash(npm run *)` | `Bash` where specifier starts with `npm run ` |
| `Bash(*)` | Any `Bash` call |
| `WebFetch(https://api.example.com/*)` | Fetch calls to that URL prefix |

Glob rules: `*` matches any sequence (including separators), `?` matches
any single character. No path semantics — `*` crosses slashes.

---

## Checking what rule matched

The bridge exposes a read-only endpoint so the dashboard (and you) can
always inspect *why* a specific tool required approval:

```
GET /approval-insights/explain?tool=Bash&specifier=git+push+origin+main
```

Response:

```json
{
  "tool": "Bash",
  "specifier": "git push origin main",
  "explanation": {
    "matchedRule": "Bash(git push *)",
    "tier": "ask",
    "source": "project"
  }
}
```

`source` is one of `managed`, `project-local`, `project`, `user`. The
Approval Insights dashboard shows this inline for every tool in your
history.

---

## Ready-made profiles

Five example policies live in [`examples/policies/`](../examples/policies/).
Copy the one closest to your situation into `.claude/settings.json`
(project-wide) or `~/.claude/settings.json` (personal baseline), then
tune from there.

### conservative

**Use when:** first-time setup, shared machine, you want to understand
what Claude is doing before trusting it more.

- Auto-approves: `Read`, documentation `WebFetch`
- Asks for: any write, any shell command, web requests
- Blocks: `rm`, `sudo`, pipe-to-bash patterns

```json
// .claude/settings.json
{ "permissions": { ... } }  // see examples/policies/conservative.json
```

### developer

**Use when:** solo developer work, single-user machine, active coding
sessions where interruptions for safe commands feel noisy.

- Auto-approves: reads, edits, writes, safe npm/git commands, grep/find
- Asks for: `git push`, `rm`, Docker, network-mutating `curl`
- Blocks: `rm -rf /`, `sudo rm`, pipe-to-bash

```json
// .claude/settings.json
{ "permissions": { ... } }  // see examples/policies/developer.json
```

### headless-ci

**Use when:** fully unattended pipeline — CI/CD, scheduled overnight
agents, batch processing. No human available to approve.

- Auto-approves: everything needed to build, test, deploy, and push
- Asks for: nothing (empty `ask` list)
- Blocks: `sudo`, pipe-to-bash patterns

> **Important:** never use this profile on an interactive machine. The
> absence of `ask` rules means Claude will execute without pausing.

```json
// .claude/settings.local.json  (don't commit this to VCS)
{ "permissions": { ... } }  // see examples/policies/headless-ci.json
```

### regulated-industry

**Use when:** medicine, law, finance, journalism, government — anywhere
data governance and audit trails matter.

- Auto-approves: `Read`, `WebSearch` only
- Asks for: every write, every shell command, every network call
- Blocks: `rm`, `sudo`, `ssh`, `scp`, pipe-to-bash

Every action that leaves a trace passes through a human decision. The
bridge records each approval/rejection, giving you a timestamped audit log.

```json
// .claude/settings.json
{ "permissions": { ... } }  // see examples/policies/regulated-industry.json
```

### personal-assistant

**Use when:** life-automation, home workflows, personal productivity —
iPhone Shortcuts, morning briefs, calendar management, smart home.

- Auto-approves: reads, writes, web requests, recipe runs, safe file ops
- Asks for: sending email, calendar mutations, network-mutating `curl`, `rm`
- Blocks: `sudo`, `rm -rf`, pipe-to-bash

```json
// ~/.claude/settings.json
{ "permissions": { ... } }  // see examples/policies/personal-assistant.json
```

---

## Layering policies

You can combine profiles across scopes:

```
~/.claude/settings.json          ← personal baseline (e.g. developer)
.claude/settings.json            ← project tightening (e.g. ask for push)
.claude/settings.local.json      ← local override (e.g. allow force-push on this machine)
```

A `deny` in any layer is permanent — the next-less-specific layer cannot
override it. Use this to enforce team-wide blocks (in `.claude/settings.json`)
while giving individuals latitude in their personal `~/.claude/settings.json`.

---

## Showing active policy in the dashboard

The Approval Insights page (`/insights`) shows:

- **Matched rule column** — the exact rule pattern that classified each
  tool in your history, plus the tier and settings file it came from.
- **Decision replay** (`/insights/replay`) — re-evaluates your past
  approval decisions against the *current* policy. Use this after
  tightening rules to see what would now auto-block.

---

## Common patterns

### Protect a single dangerous command

```json
{
  "permissions": {
    "deny": ["Bash(git push --force *)"]
  }
}
```

### Allow a specific URL, ask for everything else on the web

```json
{
  "permissions": {
    "allow": ["WebFetch(https://api.mycompany.internal/*)"],
    "ask":   ["WebFetch(*)"]
  }
}
```

### Auto-approve all reads, ask for all writes

```json
{
  "permissions": {
    "allow": ["Read"],
    "ask":   ["Edit", "Write", "Bash(*)"]
  }
}
```

### Lock a project to read-only for a code review session

```json
{
  "permissions": {
    "allow": ["Read", "WebSearch"],
    "deny":  ["Edit", "Write", "Bash(*)"]
  }
}
```
