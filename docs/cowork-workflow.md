# Cowork Workflow

Cowork is Claude Desktop's computer-use (GUI automation) mode. It has important differences from regular chat sessions.

## Key Constraints

- **MCP bridge tools are NOT available inside Cowork.** Cowork runs in an isolated subprocess that does not inherit the parent chat's MCP connection.
- **Cowork operates in a git worktree.** Files written by Cowork land in a separate branch/working copy, not your main workspace. `git status` won't show Cowork's changes until the worktree branch is merged.
- **Cowork requires Claude Max** ($100/month). If you don't see it, check your subscription.
- **Cowork shortcut:** `Cmd+2` on Mac inside Claude Desktop.

## Recommended Workflow

### Step 1 — Capture context (regular chat)

In a regular Claude Code or Claude Desktop chat (NOT inside Cowork), run:

```
/mcp__bridge__cowork
```

This prompt automatically:
1. Reads your existing handoff note (`getHandoffNote`)
2. Collects open editors, diagnostics, git status, and project info
3. Summarizes the workspace state
4. Writes a handoff note (`setHandoffNote`) for Cowork to read

### Step 2 — Open Cowork

Press `Cmd+2` (Mac) to open Cowork. The handoff note is available as context.

### Step 3 — CLAUDE.md instruction

Add this as the **first line** of your project's `CLAUDE.md` when using Cowork with a synced workspace:

```
Write all files to the workspace root, not a subdirectory.
```

Without this, Cowork may write files into a worktree subdirectory instead of the project root.

### Step 4 — Review and merge

After Cowork finishes, review its changes in the worktree branch and merge back to main:

```bash
git worktree list          # see active worktrees
git merge <worktree-branch>
```

## Handoff Note Details

Handoff notes are stored at `~/.claude/ide/handoff-note-<workspace-hash>.json` (workspace-scoped) with a fallback to `~/.claude/ide/handoff-note.json` (global). They survive bridge restarts and are limited to 10,000 characters.

The bridge auto-snapshots a basic handoff note when a new session connects and the existing note is >5 minutes old.
