---
name: ide-debug
description: Full debug workflow using IDE bridge tools. Runs tests to find failures, sets conditional breakpoints, evaluates expressions in the debugger, identifies root causes, applies fixes, and verifies. Use when debugging test failures or runtime issues.
disable-model-invocation: true
argument-hint: "[test filter or file path]"
---

# IDE Debug Workflow

## Prerequisites

Before doing anything else, call `getToolCapabilities`. Check the returned `extensionConnected` field:
- If `false` or absent: stop immediately and tell the user: "The VS Code extension is not connected to the bridge — LSP tools are unavailable. Start the bridge (`npm run start-all`) and ensure the Claude IDE Bridge extension is installed and active, then retry."
- If `true`: proceed with the steps below.

Run a complete debug cycle using the IDE bridge's debug and test tools. This workflow automates what would normally require switching between terminal, editor, and debugger.

## Workflow

### Phase 1: Identify the failure

1. Run tests using `runTests` with the provided filter argument: `$ARGUMENTS`
   - If no argument provided, run the full test suite
2. If all tests pass, report success and stop
3. For each failure, note the file, line, test name, and error message

### Phase 2: Set up debugging

4. For the first failing test, use `goToDefinition` or `openFile` to navigate to the failing code
5. Use `getDocumentSymbols` on the test file to understand the test structure
6. Use `setDebugBreakpoints` to set a breakpoint at the assertion line or the line referenced in the error
   - Use conditional breakpoints when the error message suggests a specific condition

### Phase 3: Inspect runtime state

7. Use `startDebugging` with the appropriate debug configuration
   - For vitest/jest: look for "Vitest" or "Jest" debug configs
   - For pytest: look for "Python" debug configs
8. When the breakpoint hits, use `evaluateInDebugger` to inspect:
   - The variables mentioned in the error message
   - The expected vs actual values
   - Any intermediate computation results
9. Use `getDebugState` to examine the full call stack and scope variables
10. Use `stopDebugging` once you've identified the root cause

### Phase 4: Fix and verify

11. Explain the root cause clearly
12. Use `editText` to apply the minimal fix
13. Use `saveDocument` to save the changed file
14. Re-run the failing test with `runTests` to verify the fix
15. If the fix introduces new failures, report them

### Phase 5: Clean up

16. Use `clearEditorDecorations` to remove any debug highlights
17. Summarize: what was wrong, what was fixed, and what tests now pass

## Guidelines

- Always explain the root cause before fixing
- Prefer minimal fixes over refactoring
- If you can't reproduce the failure in the debugger, fall back to adding strategic logging via `editText` and re-running
- If no debug configuration exists, suggest creating one
