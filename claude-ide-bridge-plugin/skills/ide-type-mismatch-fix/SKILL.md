---
name: ide-type-mismatch-fix
description: Diagnose and fix TypeScript/language type errors using LSP diagnostics, hover, and code actions. For each type error, fetches the expected vs actual types, surfaces quickfix suggestions, and optionally applies them. Use when getDiagnostics shows type errors you want to resolve quickly.
context: fork
agent: general-purpose
effort: high
argument-hint: "[optional: file to fix, or leave empty to fix all type errors in workspace]"
---

# IDE Type Mismatch Fixer

## Prerequisites

1. Check if `getToolCapabilities` is available.
   - **Not available**: tell the user this skill requires the Claude IDE Bridge with a connected VS Code extension, then stop.
   - **Available**: call it. If `extensionConnected` is false: show the same message and stop. If true: proceed.

## Goal

Systematically diagnose and fix type errors using LSP intelligence, without guessing or making assumptions about types.

## Workflow

### Phase 1: Collect type errors

1. Note the argument: `$ARGUMENTS`
   - If a specific file path: call `getDiagnostics` with that `uri`
   - If empty: call `getDiagnostics` with no `uri` (workspace-wide)

2. Filter diagnostics to severity `error` only. If zero errors: report "No type errors found" and stop.

3. Group errors by file. Process at most 10 files; note if more exist.

### Phase 2: Diagnose each error

For each error (up to 20 total across all files):

4. Call `getHover` at the error position (`file`, `line`, `column`) to fetch:
   - The symbol's actual type
   - The type context (what was expected)

5. Call `getCodeActions` at the error range to get quickfix suggestions from the language server

6. If the error involves a function call or method: call `getSignatureHelp` at the call site to see the expected parameter types

7. Build a diagnosis entry:
   ```
   Error: [error message]
   File: [file]:[line]:[column]
   Symbol: [symbol from hover]
   Actual type: [type from hover]
   Expected type: [inferred from error message + context]
   Quickfixes available: [list from getCodeActions]
   Recommended fix: [your recommendation]
   ```

### Phase 3: Apply fixes (if authorized)

8. For each error where a quickfix is available AND the fix is low-risk (adds a type annotation, removes `any`, fixes an import):
   - Call `previewCodeAction` to show the exact diff
   - If the diff looks correct: call `applyCodeAction` to apply it

9. After applying fixes: call `getDiagnostics` again to verify error count dropped

### Phase 4: Report

```
## Type Error Fix Report

Files with errors: N
Total errors processed: M
Fixes applied: K
Remaining errors: R

### Fixed
- src/foo.ts:42 — `string` not assignable to `number` → applied: add type cast
- ...

### Remaining (manual fix needed)
| File | Line | Error | Why manual |
|------|------|-------|-----------|
| src/bar.ts | 17 | ... | Complex generic constraint — see diagnosis below |
| ...

### Diagnoses for remaining errors
[Detailed explanation of each unfixed error with recommended fix]
```

## Guidelines

- Never apply a fix that changes function signatures or removes required parameters — these are breaking changes; report them instead
- If `getCodeActions` returns no quickfixes and the error involves generics: explain the constraint in plain English from the hover output and stop
- Process errors in order of line number per file so fixes don't invalidate later line numbers
- If a fix generates new errors: revert it (note this in the report) rather than cascading into a fix loop
