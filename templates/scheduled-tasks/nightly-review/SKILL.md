## Installation

Copy this template to your Claude Desktop scheduled-tasks directory:

```bash
mkdir -p ~/.claude/scheduled-tasks/nightly-review
cp /path/to/claude-ide-bridge/templates/scheduled-tasks/nightly-review/SKILL.md \
   ~/.claude/scheduled-tasks/nightly-review/SKILL.md
```

Then restart Claude Desktop to detect the new scheduled task. Configure the schedule in Claude Desktop settings under "Scheduled Tasks".

> The bridge must be running when this task fires. Start it with `claude-ide-bridge --watch` or `npm run start-all`.

---
---
name: nightly-review
description: Review uncommitted changes, check diagnostics, and summarize test status. Run nightly via Claude Desktop scheduled tasks.
---

# Nightly Code Review

Review the current state of the project and produce a structured report.

## Steps

1. Call `getGitStatus` to check branch state and uncommitted changes
2. Call `getGitDiff` to review the actual changes
3. Call `getDiagnostics` to check for errors and warnings across the workspace
4. Call `runTests` to verify the test suite passes

## Report Format

```
# Nightly Review — <date>

## Git
Branch: <name>
Uncommitted: <N files changed, M insertions, K deletions>

## Changes Summary
<file-by-file summary, 1 line per file: what changed and why it looks correct or concerning>

## Diagnostics
<N errors, M warnings — list files with errors>

## Tests
<N passed, M failed, K skipped (Xs)>
<list any failures with test name + reason>

## Assessment
<CLEAN | NEEDS ATTENTION | BROKEN>
<1-3 sentences summarizing the overall state and any recommended actions>
```

## Guidelines

- Be thorough but concise — this report is read the next morning
- Flag anything that looks like it was left in a broken state (failing tests, syntax errors, merge conflicts)
- If everything is clean, keep the report short: "All clear — N tests passing, 0 errors"
