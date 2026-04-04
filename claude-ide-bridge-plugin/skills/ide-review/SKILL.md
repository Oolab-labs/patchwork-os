---
name: ide-review
description: Deep PR review using IDE bridge LSP and GitHub tools. Analyzes diffs with code intelligence — follows definitions, checks references, inspects types, runs diagnostics, and posts structured review comments.
disable-model-invocation: true
effort: high
argument-hint: "[PR number]"
---

# IDE PR Review Workflow

## Prerequisites

1. Check if the `getToolCapabilities` MCP tool is available to you.
   - **Not available** (no MCP tool by that name): stop and tell the user:
     "This skill requires the Claude IDE Bridge with a connected VS Code extension. It uses LSP tools (hover, references, call hierarchy, diagnostics) and GitHub tools for deep PR analysis.

     To use this skill:
     1. Start the bridge: `npm run start-all` (in claude-ide-bridge/)
     2. Ensure the Claude IDE Bridge extension is installed in your IDE
     3. Use the `claude --ide` session (not remote-control)

     Alternative: use `gh pr diff <number>` for a basic diff review."
   - **Available**: call it. If `extensionConnected` is `false`: show the same message. If `true`: proceed.

Review a pull request using the IDE bridge's full code intelligence stack. Goes beyond diff reading by using LSP to understand the impact of changes.

## Workflow

### Phase 1: Gather PR context

1. Use `githubViewPR` to get PR details (title, description, author, base branch): `$ARGUMENTS`
2. Use `githubGetPRDiff` to get the full diff
3. Use `githubListRuns` to check CI status on the PR branch

### Phase 2: Deep code analysis

For each changed file in the diff:

4. Use `openFile` to open the file at the first changed line
5. Use `getDiagnostics` to check for any errors or warnings in modified files
6. For each modified function or class:
   - Use `getHover` to verify type signatures are correct
   - Use `findReferences` to check if callers are affected by the change
   - Use `getCallHierarchy` (incoming) to understand who depends on modified code
   - Use `goToDefinition` on any new types or imports to verify they exist
7. For renamed symbols:
   - Use `searchWorkspace` to check for any missed references (string literals, comments, config files that LSP doesn't cover)
8. For deleted code:
   - Use `findReferences` on deleted exports to verify nothing still imports them

### Phase 3: Run quality checks

9. Use `runTests` to run tests related to the changed files
10. If tests fail, note which ones and why
11. Use `getDiagnostics` to get a final diagnostic sweep across all changed files

### Phase 4: Compile review

12. Organize findings by severity:
    - **Critical**: Type errors, broken references, missing error handling, security issues
    - **Warning**: Unused imports, unnecessary changes, test gaps
    - **Suggestion**: Style improvements, documentation, alternative approaches
13. For each finding, include:
    - The file and line number
    - What the issue is
    - A concrete suggestion for how to fix it

### Phase 5: Post review (if PR number provided)

14. Use `githubPostPRReview` to post the review with appropriate event:
    - `APPROVE` if no critical or warning issues
    - `REQUEST_CHANGES` if critical issues found
    - `COMMENT` if only suggestions
15. Report the review summary

## Guidelines

- Focus on correctness over style
- Use LSP data as evidence, not just opinions
- If CI is failing, prioritize understanding why before reviewing code
- Don't nitpick formatting — that's what linters are for
