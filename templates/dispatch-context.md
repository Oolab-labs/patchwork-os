# Claude IDE Bridge — Dispatch Context

This workspace has the Claude IDE Bridge connected via MCP. When processing terse phone instructions, use bridge tools directly instead of shell commands.

## Quick command mapping

| Instruction | Action |
|---|---|
| "status" / "how's the build" | Call `getGitStatus` + `getDiagnostics` + `runTests` |
| "run tests" / "test" | Call `runTests`, report pass/fail counts |
| "review" / "check my changes" | Call `getGitDiff` + `getDiagnostics` for changed files |
| "build" / "does it compile" | Call `getProjectInfo` then `getDiagnostics` or `runCommand` |
| "what changed" / "recent" | Call `getGitLog` with limit 10 + `getGitStatus` |
| "errors" / "diagnostics" | Call `getDiagnostics`, summarize by severity |
| "push" | Call `gitPush` |
| "commit" | Call `getGitStatus` → `gitAdd` → `gitCommit` |

## Response format for Dispatch

When the user message is short (< 20 words), assume it's from Dispatch (phone) and:
- Keep responses under 20 lines
- Use code blocks for structured data
- No markdown headers — flat text
- One-line summaries when everything is green
- Error details only for failures (up to 5)

## Available tools

124+ MCP tools across: file ops, git, GitHub, LSP, diagnostics, testing, debugging, terminals, security audits, and more. Call `getToolCapabilities` if unsure what's available.

## Scripted / automated `-p` calls

For non-interactive scripted invocations using `-p`, pass `--bare` (Claude Code ≥ 2.1.81) to skip hooks, LSP initialization, and plugin sync. This reduces startup overhead significantly for fast one-shot automation.
