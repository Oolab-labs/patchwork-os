---
name: ide-dead-code-hunter
description: Find unused exports, dead functions, and unreachable code across the workspace using LSP analysis. Cross-verifies detectUnusedCode with findReferences to eliminate false positives. Use to clean up technical debt or before a major refactor.
context: fork
agent: general-purpose
effort: medium
argument-hint: "[optional: file or directory to scope the search]"
---

# IDE Dead Code Hunter

## Prerequisites

1. Check if `getToolCapabilities` is available.
   - **Not available**: tell the user this skill requires the Claude IDE Bridge with a connected VS Code extension, then stop.
   - **Available**: call it. If `extensionConnected` is false: show the same message and stop. If true: proceed.

## Goal

Find dead code — unused exports, functions with zero callers, unused imports — and produce a prioritized cleanup list with confidence badges.

## Workflow

### Phase 1: Scope

1. Note the argument: `$ARGUMENTS`
   - If a specific file path: scope search to that file only
   - If a directory: scope to that directory
   - If empty: search the entire workspace

2. Use `getProjectInfo` to understand the project type and entry points (to avoid flagging intentional public API exports as dead)

### Phase 2: Detect unused symbols

3. Call `detectUnusedCode` on each in-scope file (or workspace-wide if no scope)
4. For each reported unused symbol, call `findReferences` to cross-verify:
   - **Zero references**: confirmed dead — high confidence
   - **References only in the same file**: likely dead (internal-only) — medium confidence
   - **References in other files**: false positive from `detectUnusedCode` — skip

5. Call `searchWorkspace` with pattern `^export` on TypeScript/JS files to find exported symbols not caught by `detectUnusedCode`, then run `findReferences` on each to check usage outside the file

### Phase 3: Unused imports

6. Use `getDocumentSymbols` on each in-scope file to list import declarations
7. For any import whose symbol has zero `findReferences` results in the current file body: flag as unused import

### Phase 4: Build the report

Produce a Markdown table sorted by priority:

```
## Dead Code Report

Scoped to: [scope or "workspace-wide"]
Analyzed: N files

### High Confidence (zero external references)

| Symbol | File | Line | Type | Action |
|--------|------|------|------|--------|
| `functionName` | src/foo.ts | 42 | function | Delete |
| ...

### Medium Confidence (internal refs only)

| Symbol | File | Line | Type | Refs | Action |
|--------|------|------|------|------|--------|
| `helperFn` | src/bar.ts | 15 | function | 2 (same file) | Review |
| ...

### Unused Imports

| Import | File | Line | Action |
|--------|------|------|--------|
| `{ OldType }` | src/baz.ts | 3 | Remove |
| ...

### Summary
- High confidence dead code: N symbols
- Medium confidence: M symbols
- Unused imports: K declarations
- Estimated line reduction: ~X lines
```

## Guidelines

- Never suggest deleting public API exports that match entry points identified in Phase 1
- Flag test files separately — unused test helpers may be intentional scaffolding
- If a symbol is referenced only in `*.test.ts` files with no production callers, note it as "test-only" rather than dead
- Keep report under 60 lines for workspaces with fewer than 20 dead symbols; truncate to top 20 by confidence for larger codebases
