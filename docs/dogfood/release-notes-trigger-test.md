# Release-notes trigger dogfood test

2026-07-10: verifying the `release-notes` recipe's `git_hook`/post-commit trigger
fires `release-notes-worker` for the first time, via a commit routed through the
bridge's `gitCommit` MCP tool (required — a bare terminal `git commit` does not
fire `onGitCommit`).
