---
name: ide-quality
description: Multi-language code quality sweep using IDE bridge tools. Runs diagnostics across all languages, auto-fixes lint errors, organizes imports, formats code, runs tests, and optionally commits the cleanup.
disable-model-invocation: true
argument-hint: "[file or directory path]"
---

# IDE Quality Sweep Workflow

## Prerequisites

Before doing anything else, call `getToolCapabilities`. Check the returned `extensionConnected` field:
- If `false` or absent: stop immediately and tell the user: "The VS Code extension is not connected to the bridge — LSP tools are unavailable. Start the bridge (`npm run start-all`) and ensure the Claude IDE Bridge extension is installed and active, then retry."
- If `true`: proceed with the steps below.

Run a comprehensive code quality sweep using the IDE bridge's multi-language linting, formatting, and testing tools.

## Workflow

### Phase 1: Assess the environment

1. Use `getToolCapabilities` to discover available linters, formatters, and test runners
2. Use `getProjectInfo` to understand the project type and languages
3. Determine the scope: if `$ARGUMENTS` is provided, focus on that path; otherwise sweep the whole workspace

### Phase 2: Collect all diagnostics

4. Use `getDiagnostics` to get errors and warnings across the workspace
5. Group diagnostics by severity (error → warning → info) and by file
6. Report the total count: "Found N errors, M warnings across K files"

### Phase 3: Auto-fix

7. For each file with fixable diagnostics:
   - Use `fixAllLintErrors` to apply auto-fixes
   - Use `organizeImports` to clean up imports
   - Use `formatDocument` to apply consistent formatting
8. Use `getDiagnostics` again to see what remains after auto-fixing
9. Report: "Auto-fixed X issues. Y issues remain that need manual attention."

### Phase 4: Manual fixes (remaining errors only)

10. For remaining errors (not warnings), analyze the diagnostic message
11. Use `getHover` and `goToDefinition` to understand the context
12. Use `editText` to apply targeted fixes
13. Use `saveDocument` after each fix

### Phase 5: Verify

14. Use `runTests` to run the test suite
15. If tests fail, identify if the failure was caused by our changes:
    - Use `getDiagnostics` on test files
    - If we broke something, revert the specific change
16. Use `getDiagnostics` one final time to confirm we haven't introduced new issues

### Phase 6: Report and optionally commit

17. Summarize all changes made:
    - Files modified
    - Issues fixed (auto vs manual)
    - Issues remaining (with explanations)
    - Test results
18. Ask whether to commit the cleanup:
    - If yes: `gitAdd` the changed files, `gitCommit` with message "chore: fix lint errors and format code"

## Guidelines

- Never auto-fix if it would change behavior (only style/lint fixes)
- Preserve existing formatting choices when they don't violate linter rules
- If a diagnostic seems like a false positive, skip it and note it in the report
- Group related fixes into logical units
