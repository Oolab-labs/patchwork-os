---
name: ide-refactor
description: Safe refactoring with git-backed rollback. Verifies a clean working tree, performs the refactoring using LSP rename and code actions, runs tests, and offers to revert via git if anything breaks.
disable-model-invocation: true
effort: high
argument-hint: "[description of refactoring]"
---

# IDE Safe Refactor Workflow

## Prerequisites

1. Check if the `getToolCapabilities` MCP tool is available to you.
   - **Not available** (no MCP tool by that name): stop and tell the user:
     "This skill requires the Claude IDE Bridge with a connected VS Code extension. It uses LSP tools (rename symbol, code actions, references, snapshots) that have no CLI equivalent.

     To use this skill:
     1. Start the bridge: `npm run start-all` (in claude-ide-bridge/)
     2. Ensure the Claude IDE Bridge extension is installed in your IDE
     3. Use the `claude --ide` session (not remote-control)"
   - **Available**: call it. If `extensionConnected` is `false`: show the same message. If `true`: proceed.

Perform refactoring with a safety net. The safety net is **git**: the working
tree is verified clean before anything is touched, so `git checkout` reverts the
whole change if tests fail afterwards.

## Workflow

### Phase 1: Checkpoint

There is no snapshot tool. Git is the rollback mechanism, and it only works if
the tree is clean first — otherwise a revert would discard the user's unrelated
work along with the refactoring.

1. Call `getGitStatus`.
   - **Clean tree**: proceed. `git checkout -- .` will revert everything this
     skill does.
   - **Uncommitted changes present**: stop and offer the choice —
     "You have uncommitted changes. I can't offer a clean rollback until they're
     saved. Commit them, or shall I `gitStash` them first and restore them
     after?" Never proceed silently: doing so leaves the user with no way to
     undo the refactor without also losing their own work.
2. Confirm: "Working tree clean — `git checkout` will revert this. Starting
   refactoring: $ARGUMENTS"

### Phase 2: Plan the refactoring

3. Analyze what needs to change based on the description: `$ARGUMENTS`
4. Use `searchWorkspace` and `getDocumentSymbols` to identify all affected symbols
5. Use `findReferences` to map the impact across the codebase
6. Use `getCallHierarchy` to understand dependency chains
7. List all files that will be affected and confirm the plan

### Phase 3: Execute the refactoring

For symbol renames:
8. Use `refactorAnalyze` on the target symbol first:
   - Returns `risk` (low/medium/high), `referenceCount`, and `callerCount`
   - If `risk` is **high** (>20 refs or >10 callers): write tests covering the symbol before proceeding, then confirm with the user
   - If `risk` is **medium**: note the reference count in your confirmation message
   - If `risk` is **low**: proceed directly
9. Use `refactorPreview` to show the exact edits that will be made — confirm with the user before applying
10. Use `renameSymbol` — this handles all references across the workspace via LSP

For structural changes:
11. Use `getCodeActions` to check if VS Code has automated refactorings available
12. Use `applyCodeAction` for supported refactorings (extract method, extract variable, etc.)
13. Use `editText` for manual structural changes

### Phase 4: Clean up

14. Use `organizeImports` on every modified file
15. Use `formatDocument` on every modified file
16. Use `getDiagnostics` to check for new errors introduced by the refactoring

### Phase 5: Verify

17. Use `runTests` to run the full test suite
18. If all tests pass:
    - Report success with a summary of changes
    - Say plainly that the change is **unstaged and uncommitted**, so
      `git checkout -- .` still reverts it, and that this stops being true once
      it is committed
19. If tests fail:
    - Use `getGitDiff` to show exactly what changed
    - Ask: "Tests failed. Would you like me to revert?"
    - If yes: use `gitCheckout` to discard the working-tree changes. If Phase 1
      stashed anything, restore it afterwards and say so
    - If no: report which tests failed and why, so the user can fix manually

### Phase 6: Summary

20. Report:
    - What was refactored
    - How many files changed
    - Symbol renames performed
    - Code actions applied
    - Test results
    - Whether the snapshot was used for rollback

## Guidelines

- Always create a snapshot before any changes
- Prefer `renameSymbol` over manual find-and-replace — it handles all language-aware references
- Check for string references that LSP rename won't catch (config files, comments, documentation)
- If the refactoring is too large, suggest breaking it into smaller steps
