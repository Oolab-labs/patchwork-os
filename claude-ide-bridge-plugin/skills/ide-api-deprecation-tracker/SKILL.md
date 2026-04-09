---
name: ide-api-deprecation-tracker
description: Find all @deprecated APIs in the workspace, count their callers, and extract migration guidance. Produces a prioritized report sorted by call count so you know which deprecations to tackle first.
context: fork
agent: general-purpose
effort: low
argument-hint: "[optional: file, directory, or package name to scope the search]"
---

# IDE API Deprecation Tracker

## Prerequisites

1. Check if `getToolCapabilities` is available.
   - **Not available**: tell the user this skill requires the Claude IDE Bridge, then stop.
   - **Available**: call it. If `extensionConnected` is false: show the same message and stop. If true: proceed.

## Goal

Produce a Markdown report of all deprecated APIs ranked by caller count, with migration paths extracted from JSDoc.

## Workflow

### Phase 1: Find deprecated symbols

1. Note the argument: `$ARGUMENTS`
   - If a scope is given, pass it as the `include` glob to `searchWorkspace`
   - Otherwise, search workspace-wide

2. Call `searchWorkspace` with pattern `@deprecated` to find all files containing deprecation annotations. This catches:
   - `/** @deprecated ... */` JSDoc comments
   - `@deprecated` in TSDoc, Python docstrings, Go comments, etc.

3. For each match, call `getHover` at the annotated symbol's position to extract:
   - The full deprecation message (migration guidance)
   - The symbol name and type signature

### Phase 2: Count callers

4. For each deprecated symbol found in Phase 1:
   - Call `searchWorkspaceSymbols` to locate the symbol's definition precisely
   - Call `findReferences` on the definition to count all call sites
   - Record: symbol name, file, line, reference count, deprecation message

### Phase 3: Extract migration paths

5. For symbols with a migration path mentioned in `@deprecated` (e.g., "use `newFunction` instead"):
   - Extract the replacement symbol name from the hover text
   - Call `searchWorkspaceSymbols` to verify the replacement exists

### Phase 4: Report

```
## API Deprecation Report

Workspace: [project name]
Deprecated APIs found: N
Total call sites to migrate: M

### High Priority (>10 callers)

| API | File | Callers | Replacement | Deprecation message |
|-----|------|---------|-------------|---------------------|
| `oldFn()` | src/utils.ts:42 | 47 | `newFn()` ✓ | Use newFn() — supports async |
| ...

### Medium Priority (3–10 callers)

| API | File | Callers | Replacement | Deprecation message |
|-----|------|---------|-------------|---------------------|
| ...

### Low Priority (1–2 callers)

| API | File | Callers | Replacement |
|-----|------|---------|-------------|
| ...

### No Migration Path

These are deprecated with no documented replacement:
| API | File | Callers | Message |
|-----|------|---------|---------|
| ...

### Summary
- APIs to migrate: N
- Call sites to update: M
- APIs with clear migration path: K / N
- Suggestion: Start with high-priority APIs — they have the most callers and the clearest migration paths.
```

## Guidelines

- A "caller" is any `findReferences` result that is not the definition itself and not in a `*.test.ts` / `*_test.go` / `test_*.py` file (test-only callers are noted separately but don't count toward priority)
- If a replacement symbol is mentioned but `searchWorkspaceSymbols` finds nothing: flag as "replacement not found" — the migration target may have been renamed or removed
- Cap the report at 50 deprecated APIs; note total if more exist
- Keep the full report under 80 lines for readability
