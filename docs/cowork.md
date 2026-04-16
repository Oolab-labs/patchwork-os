# Cowork (Computer-Use) Workflow

> ## ⚠ READ BEFORE OPENING COWORK
>
> **Bridge MCP tools do NOT work inside Cowork.** `getDiagnostics`, `goToDefinition`, `gitCommit`, and every other bridge tool are unreachable from within a Cowork session. This is a fundamental architectural constraint — there is no configuration that changes it.
>
> **Before switching to Cowork:** run `/mcp__bridge__cowork` in regular Claude Code or Desktop chat. This single prompt captures workspace state (open editors, diagnostics, git status/diff) and writes it to the handoff note that Cowork can read at start.
>
> **If tools vanish inside Cowork:** you forgot to run the prompt, or you opened Cowork from the wrong client. Exit Cowork, run `/mcp__bridge__cowork` in regular chat, re-open Cowork.

---

## Overview

Cowork is Claude's computer-use mode. The MCP server cannot be reached from within a Cowork session — the transport layer is isolated by design.

The workaround: gather all IDE context *before* entering Cowork, write it to the handoff note, then Cowork reads that note at the start.

---

## Before You Start: Gather IDE Context

Run the `/mcp__bridge__cowork` prompt in regular Claude Code or Claude Desktop chat — **not** from inside Cowork.

What this prompt does automatically:
- Calls `contextBundle` — active file, open editors, workspace summary
- Calls `getGitStatus` — staged/unstaged changes, current branch
- Calls `getGitDiff` — full diff of pending changes
- Calls `getDiagnostics` — current errors and warnings
- Calls `setHandoffNote` — writes all gathered state into the workspace-scoped handoff note

Once the prompt completes, Cowork can read that note via `getHandoffNote`.

---

## Step-by-Step Workflow

```
1. Regular Claude Code or Desktop chat
   └── Run: /mcp__bridge__cowork
       └── Claude calls: contextBundle, getGitStatus, getGitDiff, getDiagnostics
       └── Claude calls: setHandoffNote (writes IDE context)

2. Open Cowork
   └── Mac: Cmd+2
   └── Cowork session reads handoff note for context

3. Do the work in Cowork
   └── File reads/writes work (OS-level, worktree branch)
   └── Shell commands work
   └── Browser automation works
   └── MCP bridge tools do NOT work

4. Exit Cowork

5. Back in regular chat
   └── Review worktree branch in VS Code
   └── Merge worktree branch to main
```

---

## Worktree Isolation

Cowork operates in an **isolated git worktree** — not the main workspace root. Files Cowork creates or modifies land in the worktree branch, not `main`.

After Cowork finishes:
- The `git status` on main will NOT show Cowork's changes until merged
- Review the worktree branch in VS Code using the Source Control panel or `git worktree list`
- Merge the worktree branch back to main manually:

```bash
git checkout main
git merge <cowork-branch-name>
```

### Critical: CLAUDE.md First Line

Always add the following as the **first instruction** in the workspace `CLAUDE.md` before using Cowork:

```
Write all files to the workspace root, not a subdirectory.
```

Without this, Cowork sometimes creates files in nested locations relative to the worktree root instead of the workspace root. This is the most common cause of "where did my files go" issues.

---

## What's Available in Cowork vs. Regular Chat

| Capability | Regular Chat | Cowork |
|---|---|---|
| MCP bridge tools (LSP, debug, git, etc.) | Yes | No |
| VS Code extension features | Yes | No |
| `getDiagnostics`, `goToDefinition`, etc. | Yes | No |
| File reads/writes (OS-level) | Yes | Yes (worktree) |
| Shell commands | Yes | Yes |
| Browser automation | No | Yes |
| Handoff note — write | Yes | Limited |
| Handoff note — read | Yes | Yes |

---

## Handoff Note Contract

- Notes are **workspace-scoped** — switching workspaces will not overwrite another workspace's note
- Maximum note size is a few KB; keep content focused on what changed, current task, and key file paths — not full file dumps
- The `onInstructionsLoaded` automation hook may **overwrite the note** at session start with a generic template. If the note content looks generic or templated, treat it as stale and consult a persistent session log (e.g. `docs/session-log.md`)
- When multiple Claude sessions are running, only the session doing active work should call `setHandoffNote`; other sessions can read freely

---

## Multi-Session Context Sharing

When running multiple Claude sessions simultaneously:

1. Session A (regular chat) calls `/mcp__bridge__cowork` → writes handoff note
2. Session B (Cowork) opens → reads handoff note at start
3. Session A should not overwrite the note while Session B is using it
4. After Cowork finishes, Session A can call `setHandoffNote` again to capture the outcome

---

## Troubleshooting

### Cowork doesn't have the right context

You did not run `/mcp__bridge__cowork` before switching. Exit Cowork, run the prompt in regular chat, then return.

### Files ended up in the wrong directory

Add `"Write all files to workspace root, not a subdirectory."` as the first line of `CLAUDE.md` in your workspace. This must be the first instruction so Cowork reads it before doing any file work.

### Changes not visible in main git status

Expected — Cowork uses a worktree branch. The worktree is isolated by design. Merge the branch back manually:

```bash
git worktree list          # find the cowork branch name
git checkout main
git merge <cowork-branch>
git worktree remove <path> # optional cleanup
```

### Bridge tools show as available but calls fail

You are inside Cowork. The MCP server is unreachable from Cowork regardless of what the tool list shows. Exit Cowork and use regular Claude Code for anything requiring bridge tools.

### Handoff note looks generic or out of date

The `onInstructionsLoaded` automation hook may have overwritten it at session start. Check `docs/session-log.md` (if maintained) or re-run `/mcp__bridge__cowork` in regular chat to refresh the note before switching.

### Cowork created a nested subdirectory instead of editing workspace root files

The CLAUDE.md first-line instruction is missing or was not at the top. Cowork reads instructions top-to-bottom; if the instruction appears after other content it may be ignored. Move it to line 1.

---

## Quick Reference

```
# Before Cowork — run in regular Claude Code/Desktop:
/mcp__bridge__cowork

# After Cowork — merge worktree back:
git checkout main && git merge <cowork-branch>

# If files are in the wrong place:
# Add to top of CLAUDE.md: "Write all files to workspace root, not a subdirectory."
```

---

## Related

- `CLAUDE.md` — cowork workflow summary (inline notes)
- `docs/session-log.md` — persistent session log (if maintained in your workspace)
- `setHandoffNote` / `getHandoffNote` — MCP tools for passing context between sessions
- `/mcp__bridge__cowork` — MCP prompt that bundles IDE context before Cowork
