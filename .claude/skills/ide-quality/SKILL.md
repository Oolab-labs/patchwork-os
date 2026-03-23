---
name: ide-quality
description: Multi-language code quality sweep using IDE bridge tools. Runs diagnostics across all languages, auto-fixes lint errors, organizes imports, formats code, runs tests, and optionally commits the cleanup.
disable-model-invocation: true
effort: high
argument-hint: "[file or directory path]"
---

# IDE Quality Sweep Workflow

## Prerequisites

1. Check if the `getToolCapabilities` MCP tool is available to you.
   - **Available**: call it, check `extensionConnected` → use **IDE Path** below.
   - **Not available**: use **CLI Path** below.

## IDE Path

Use this path when bridge MCP tools are available and extension is connected.

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

---

## CLI Path

Use this path when bridge MCP tools are NOT available (e.g., remote-control sessions).

### Phase 1: Assess the environment

1. Detect project type by checking for config files using **Glob**: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`
2. Read `package.json` (or equivalent) with **Read** to understand frameworks and scripts
3. Determine the scope from `$ARGUMENTS`

### Phase 2: Run linters via CLI

4. Detect and run available linters via **Bash**:
   - `tsconfig.json` → `npx tsc --noEmit 2>&1`
   - `biome.json`/`biome.jsonc` → `npx biome check . 2>&1`
   - `.eslintrc*`/`eslint.config.*` → `npx eslint . 2>&1`
   - `pyrightconfig.json` → `npx pyright 2>&1`
   - `Cargo.toml` → `cargo check 2>&1`
5. Parse output and group by severity and file
6. Report the total count

### Phase 3: Auto-fix via CLI

7. Run linter auto-fix commands via **Bash**:
   - biome: `npx biome check . --write 2>&1`
   - eslint: `npx eslint . --fix 2>&1`
   - ruff: `ruff check . --fix 2>&1`
8. Run formatters via **Bash**:
   - biome: `npx biome format . --write 2>&1`
   - prettier: `npx prettier --write . 2>&1`
   - black: `black . 2>&1`
9. Re-run linters to see what remains
10. Report: "Auto-fixed X issues. Y issues remain."

### Phase 4: Manual fixes

11. For remaining errors, read the affected files with **Read**
12. Apply targeted fixes with **Edit**
13. Re-run the specific linter to verify

### Phase 5: Verify

14. Run tests via **Bash**: `npm test 2>&1` (or `pytest`, `cargo test`, etc.)
15. If tests fail and the failure was caused by our changes, revert with **Bash**: `git checkout -- <file>`

### Phase 6: Report and optionally commit

16. Summarize changes (same format as IDE Path)
17. If user wants to commit: use **Bash**: `git add <files> && git commit -m "chore: fix lint errors and format code"`

---

## Guidelines

- Never auto-fix if it would change behavior (only style/lint fixes)
- Preserve existing formatting choices when they don't violate linter rules
- If a diagnostic seems like a false positive, skip it and note it in the report
- Group related fixes into logical units
- For a visual diagnostics overview, suggest `/ide-diagnostics-board`
