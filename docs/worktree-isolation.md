# Worktree Isolation with Claude IDE Bridge

Claude Code's `isolation: worktree` feature creates a temporary git worktree so a subagent can make file edits on a separate branch without touching the main session's working tree. This document explains how that interacts with the bridge and what's safe to do.

---

## How worktree isolation works

When a subagent is defined with `isolation: worktree`, Claude Code:

1. Creates a new git worktree (a separate checkout of the repo at a new path)
2. Launches the subagent with that worktree as its working directory
3. Cleans up the worktree when the subagent finishes (or merges its changes)

The main session and worktree agent run concurrently. File edits in the worktree don't affect the main branch — they're on a temporary branch that can be reviewed and merged.

---

## What the bridge can and can't do in a worktree

### Safe in worktree agents ✅

These tools read from or write to the **filesystem** and are fully path-aware — they operate on whatever files are passed to them, regardless of which checkout they're in:

- `readFile`, `writeFile`, `editText`, `createFile`, `deleteFile`
- `getFileTree`, `findFiles`, `searchWorkspace`
- `getGitStatus`, `getGitDiff`, `gitAdd`, `gitCommit` (on the worktree's branch)
- `runTests`, `runCommand`, `runInTerminal` (if run in the worktree directory)
- `getDiagnostics` via CLI linters (not the extension — see below)

### Use with care ⚠️

These tools go through the **VS Code extension**, which reflects whichever file VS Code has open in the main window — not the worktree:

- `openFile`, `getOpenEditors`, `getHover`, `goToDefinition`, `findReferences`
- `getCallHierarchy`, `getDocumentSymbols`, `getInlayHints`
- `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger`
- `setEditorDecorations`, `formatDocument`, `organizeImports`

If the main session has `src/bridge.ts` open and the worktree agent calls `getHover` on its modified copy of `src/bridge.ts`, VS Code will resolve hover information from the **main session's open file**, not the worktree's version. This gives stale type information.

**Rule of thumb:** LSP and extension tools in a worktree agent reflect the main session's view, not the worktree's.

### Avoid in worktree agents ❌

These tools mutate shared state that the main session also owns:

- `gitPush` — both sessions pushing could conflict
- `gitCheckout` — changes the branch in a way that could affect the main session if they share a worktree path
- `runClaudeTask` — launches a Claude subprocess that inherits the main session's MCP config

---

## Recommended subagent pattern for safe parallel edits

Define worktree agents with `disallowedTools` to prevent accidental LSP/extension tool calls:

```markdown
---
name: my-parallel-agent
description: Makes file edits in an isolated branch
isolation: worktree
memory: project
disallowedTools: setDebugBreakpoints, startDebugging, evaluateInDebugger, setEditorDecorations, openFile
---

You are working in an isolated git worktree. Use file tools (readFile, editText, writeFile)
and CLI tools (runTests, runCommand) only. Do not use IDE extension tools — they reflect
the main session's editor state, not this worktree.
```

---

## WorktreeCreate hook

The bridge plugin registers a `WorktreeCreate` hook (`scripts/worktree-create.sh`) that fires whenever Claude Code creates a worktree. It checks whether the new worktree belongs to the same repo as the running bridge and injects a message telling the agent:

- Whether bridge IDE tools are scoped to this worktree
- A reminder to prefer read-only IDE tools if they share the same repo
- That file/git/terminal tools are always safe

This means agents don't need to figure out the bridge topology themselves.

---

## Multiple bridge instances

Each bridge instance is tied to one workspace. If you run two bridge instances — one for the main session and one specifically for the worktree — they operate completely independently and each extension connection reflects its own workspace. This gives full IDE tool support in both, but requires two terminal sessions and two VS Code windows.

For most use cases, a single bridge with the `disallowedTools` pattern above is simpler and works well.

---

## Tool Search and worktrees

With 135+ bridge tools, Claude Code's MCP Tool Search activates to help Claude find relevant tools. Tool Search operates per-session — the worktree agent's tool search is scoped to its own context. There's no cross-session tool leakage.

---

## Summary

| Tool category | Safe in worktree agent? |
|---|---|
| File read/write (`readFile`, `editText`, …) | ✅ Always safe |
| Git tools (`getGitStatus`, `gitCommit`, …) | ✅ Safe on worktree branch |
| CLI runners (`runTests`, `runCommand`) | ✅ Safe if run in worktree dir |
| LSP tools (`getHover`, `findReferences`, …) | ⚠️ Reflects main session's view |
| Debugger tools | ⚠️ Reflects main session's debug state |
| Editor mutation (`formatDocument`, `openFile`) | ⚠️ Affects main session's editor |
| `gitPush`, `gitCheckout` | ❌ Can conflict with main session |
