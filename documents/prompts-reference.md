# MCP Prompts Reference

## Overview

MCP prompts are reusable prompt templates invocable via `prompts/get`, or as `/prompt-name` in Claude Code and the Claude Desktop `/` picker. The bridge ships **36** prompts, all defined in [`src/prompts.ts`](../src/prompts.ts).

This document catalogs every shipped prompt. The runtime `prompts/list` call is the authoritative source — if a name here ever disagrees with `prompts/list`, trust `prompts/list`. Prompts appear in the picker automatically when the bridge is connected.

> **Counts:** 9 core · 5 Dispatch · 2 agent/scheduled · 1 setup · 16 LSP composition · 3 edit workflow = **36**. The sections below mirror the grouping in `src/prompts.ts`.

Arguments are passed as `key=value` pairs after the name. Prompts that take no arguments are invoked with just `/prompt-name`. Required arguments are marked **(required)**.

---

## Core prompts (9)

Review, context, and setup helpers for everyday IDE work.

| Prompt | What it does | Arguments |
|--------|--------------|-----------|
| `review-changes` | Review uncommitted changes to a specific file: diff, diagnostics, churn risk, and architectural context. | `file` **(required)** |
| `review-file` | Code review of a file: correctness, style, performance, security, and coverage gaps. | `file` **(required)** |
| `explain-diagnostics` | Explain diagnostics (errors/warnings) for a file and suggest fixes. | `file` **(required)** |
| `generate-tests` | Generate missing unit tests for a file using the project's test conventions. | `file` **(required)** |
| `debug-context` | Snapshot IDE state (open editors, diagnostics, recent terminal output) as debugging context. | — |
| `git-review` | Review uncommitted changes (staged + unstaged) against a base branch before commit or PR. | `base` (default: `main`) |
| `cowork` | Load IDE context (open files, diagnostics, git status, project info, handoff note) and propose a Cowork action plan. Run before any computer-use task. | `task` (optional focus) |
| `gen-claude-md` | Generate bridge workflow rules and quick-reference table, then write them into `CLAUDE.md`. | — |
| `set-effort` | Prepend a model-effort instruction to the next task. `low`=quick, `medium`=normal, `high`=complex refactors/deep analysis. | `level` (default: `medium`) |

---

## Dispatch prompts (5)

Short, terse prompts designed for mobile use via Claude Desktop Dispatch or Siri. Invoke by the phone phrase or by typing the name in any chat. These read git/build state, so they require **full mode** (the default).

| Prompt | Phone phrase | What it does | Arguments |
|--------|--------------|--------------|-----------|
| `project-status` | "How's the build?" | Quick health check: git status, diagnostics, and test results. Terse output. | — |
| `quick-tests` | "Run the tests" | Run tests and return a concise pass/fail summary with failure details. | `filter` (optional) |
| `quick-review` | "Review my changes" | Git diff summary plus diagnostics for changed files. Concise output. | — |
| `build-check` | "Does it build?" | Check if the project builds successfully. Returns pass/fail with error summary. | — |
| `recent-activity` | "What changed?" | Last N git log entries plus uncommitted changes summary. | `count` (default: `10`) |

---

## Agent teams & scheduled prompts (2)

| Prompt | What it does | Arguments | Notes |
|--------|--------------|-----------|-------|
| `team-status` | Active agent sessions and recent tool activity. For team leads coordinating parallel agents. | — | Requires multiple Claude Code sessions connected simultaneously. |
| `health-check` | Full health check: tests, diagnostics, security advisories, git status, dependency audit. | — | Suited to scheduled nightly/hourly runs. |

---

## Setup prompt (1)

| Prompt | What it does | Arguments |
|--------|--------------|-----------|
| `orient-project` | Set up a project for Claude IDE Bridge: detects project type, generates/updates `CLAUDE.md`, scaffolds docs, and verifies connectivity. Idempotent. | `style` — `minimal` (CLAUDE.md only), `standard` (+ `documents/`, `docs/adr/`, `.claude/rules/`), `full` (+ commands, agents, use-cases). Default: `standard`. |

---

## LSP composition prompts (16)

These wrap the bridge's LSP primitives and composites (`getChangeImpact`, `explainSymbol`, `refactorAnalyze`, etc.) into one-call developer workflows. Available in slim mode unless the description says otherwise.

| Prompt | What it does | Arguments |
|--------|--------------|-----------|
| `find-callers` | Find every caller of a symbol with file:line locations. Wraps `searchWorkspaceSymbols` + `getCallHierarchy(incoming)` + `findReferences`. | `symbol` **(required)** |
| `blast-radius` | Blast radius at a position: diagnostics + reference counts + risk badge. Wraps `getChangeImpact`. | `file`, `line`, `column` **(all required)** |
| `why-error` | Explain a diagnostic in plain English with surrounding type context. Wraps `getDiagnostics` + `explainSymbol`. | `file` **(required)**, `line` (default: first error) |
| `unused-in` | List unused exports, parameters, and imports in a file. Wraps `detectUnusedCode` + `findReferences`. | `file` **(required)** |
| `trace-to` | Trace call chain to a target symbol with type signatures at each hop. Wraps `getCallHierarchy(outgoing)` + `getImportedSignatures`. | `symbol` **(required)** |
| `imports-of` | List files importing a symbol with reference counts. Wraps `findReferences` + `getImportTree`. | `symbol` **(required)** |
| `circular-deps` | Detect circular import dependencies. Wraps `getImportTree` with cycle detection. | — |
| `refactor-preview` | Preview the exact edits a rename would make plus blast-radius risk. Wraps `refactorAnalyze` + `refactorPreview`. | `file`, `line`, `column`, `newName` **(all required)** |
| `module-exports` | List exported symbols with type signatures as Markdown. Wraps `getDocumentSymbols` + `getHover`. | `file` **(required)** |
| `type-of` | Type signature at a position (no docs). Wraps `getHoverAtCursor` + `getTypeSignature`. | `file`, `line`, `column` **(all required)** |
| `deprecations` | Find `@deprecated` APIs and count callers. Wraps `searchWorkspace` + `findReferences`. | — |
| `coverage-gap` | Identify untested functions by correlating coverage with document symbols. Wraps `getCodeCoverage` + `getDocumentSymbols`. | `file` **(required)** |
| `explore-type` | Explore a type: declaration, definition, and all implementations. Wraps `getHover` + `goToDeclaration` + `goToTypeDefinition` + `findImplementations`. | `file`, `line`, `column` **(all required)** |
| `ide-coverage` | Generate an HTML coverage heatmap and open it in the browser. **Requires full mode** (`getCodeCoverage` + `openInBrowser`). | — |
| `ide-deps` | D3 force-directed dependency graph for an entry point, opened in the browser. **Requires full mode.** | `file`, `line`, `column` **(all required)** |
| `ide-diagnostics-board` | Workspace diagnostics grouped by severity/file, rendered as a sortable HTML table in the browser. | — |

---

## Edit workflow prompts (3)

| Prompt | What it does | Arguments |
|--------|--------------|-----------|
| `safe-refactor` | Multi-file refactor with preview-before-apply: shows a unified diff per file, asks for confirmation, then applies atomically via transaction. | `description` **(required)**, `files` (optional, scopes the refactor) |
| `diagnose-and-fix` | Explain the first diagnostic error, propose and preview a fix, apply it, then re-check diagnostics. | `filePath` (optional; omit for workspace-wide first error) |
| `session-delta` | Orient at session start: diff + diagnostic changes since last handoff note, with a suggested next action. | — |

---

## Referencing prompts from automation policy

Automation hooks can invoke any of these prompts by name instead of carrying an inline `prompt` string. Use `promptName` and pass arguments with `promptArgs`:

```json
{
  "onFileSave": {
    "enabled": true,
    "promptName": "review-changes",
    "promptArgs": { "file": "{{file}}" }
  }
}
```

Bridge placeholder expansion happens first — `{{file}}` is replaced with the actual file path before being passed to the prompt. This keeps automation policy files clean and avoids duplicating long prompt strings across hook entries. See [automation.md](../docs/automation.md) for the full hook list.

---

## Invoking prompts from Claude Code

```
/project-status
/explore-type file=src/foo.ts line=42 column=8
/generate-tests file=src/utils.ts
/review-changes file=src/billing.ts
/safe-refactor description="rename UserService to AccountService"
```

In Claude Desktop, prompts appear in the `/` picker; typing the first few characters filters the list.

---

## Availability by mode

Most prompts run in **slim mode**. The few that require **full mode** (the default since v2.43.0) are those that shell out, touch git, or open a browser:

| Requires full mode | Reason |
|--------------------|--------|
| All 5 Dispatch prompts | read git status / run tests / build |
| `git-review`, `health-check`, `coverage-gap` | git / test / coverage tooling |
| `ide-coverage`, `ide-deps` | open rendered HTML in the browser |

Call `getToolCapabilities` at session start to confirm which tools — and therefore which prompts — are active in the current mode.
