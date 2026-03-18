---
title: Marketplace Listing Plan — claude-ide-bridge v2.3.0
created: 2026-03-17T20:53:19.589Z
updated: 2026-03-17T20:53:19.589Z
---

## Phase 1 — Plugin Package Audit

- [ ] Audit .claude-plugin/plugin.json: verify name, version, description, tags, homepage, and icon fields against the official schema
- [ ] Audit .mcp.json: command uses claude-ide-bridge binary — verify npx fallback and correct args for typical user setup
- [ ] Audit all 9 skills: valid frontmatter, step-by-step instructions, graceful fallback when bridge is not running
- [ ] Audit 3 agents (ide-code-reviewer, ide-debugger, ide-test-runner): descriptions, model hints, bridge availability guard clauses
- [ ] Check hooks.json: verify WorktreeCreate hook is wired in (script exists but may be missing from hooks.json)
- [ ] Add icon.png (512x512) to plugin package root for the /plugin Discover UI

## Phase 2 — Repository and NPM Setup

- [ ] Create public GitHub repo: kilibasi/claude-ide-bridge-plugin (plugin homepage that Anthropic will link to)
- [ ] Publish npm package claude-ide-bridge v2.3.0 — verify binary in package.json bin field (8 commits unpublished)
- [ ] Tag GitHub release v2.3.0 with changelog from documents/roadmap.md
- [ ] Verify VS Code extension v1.0.9 is live on VS Code Marketplace and Open VSX (currently installed locally only)
- [ ] Write plugin repo README: what it does, prerequisites, quick-start, skills/agents list, screenshot/gif of tool in action

## Phase 3 — Quality Bar

- [ ] Run npm run smoke — confirm 23 PASS / 0 FAIL baseline before submission
- [ ] Run getDiagnostics on workspace — resolve any TS errors or Biome warnings
- [ ] Write updated SETUP.md covering the plugin installation flow specifically (for Anthropic QA reviewers)
- [ ] Record a demo gif: bridge running -> plugin installed -> a skill in action (e.g. /ide-diagnostics-board)
- [ ] Write a one-paragraph elevator pitch for the submission form (105 tools, editor-agnostic, SSH remote, 1237 unit tests)

## Phase 4 — Submission

- [ ] Submit via clau.de/plugin-directory-submission (direct PRs to the repo are auto-closed by GitHub Action)
- [ ] Categorize as Developer Tools / IDE Integration with tags: ide, vscode, windsurf, cursor, lsp, debugging, mcp
- [ ] Provide setup instructions or testing account for Anthropic QA to verify end-to-end
- [ ] Monitor anthropics/claude-plugins-official for follow-up review comments
- [ ] After listing: update main README with install command: /plugin install claude-ide-bridge@claude-plugins-official

## Phase 5 — Post-Listing Surfaces (Future)

- [ ] Anthropic Connectors Directory: submit the remote bridge (hosted URL) separately for claude.ai and Claude Desktop users without Claude Code
- [ ] Enterprise Claude Marketplace (claude.com/platform/marketplace): invite-only, requires existing enterprise Anthropic spend — apply after the plugin has meaningful adoption metrics
