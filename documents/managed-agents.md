# Anthropic Managed Agents — MCP Integration Guide

Attach a VPS-hosted claude-ide-bridge to an [Anthropic Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) using the bridge's Streamable HTTP transport. The cloud agent gains real workspace tools (git, file search, test runner, diagnostics) via MCP.

---

## Prerequisites

1. **VPS with bridge running** — `--bind 0.0.0.0 --full --fixed-token <uuid>`
2. **nginx + TLS** — Managed Agents requires HTTPS. Use `deploy/bootstrap-new-vps.sh` or follow `docs/remote-access.md` Option 3.
3. **Fixed token** — use `--fixed-token` so the token doesn't rotate between agent invocations.
4. **Port 443 open** — bridge sits behind nginx on standard HTTPS.

Minimal launch command (after nginx is in place):

```bash
claude-ide-bridge \
  --bind 0.0.0.0 \
  --full \
  --fixed-token "$(uuidgen)" \
  --watch \
  --workspace /path/to/project
```

Store the token in a secrets manager. Never commit it to version control.

---

## MCP Server Config

Managed Agents attach external MCP servers under **Settings → MCP Servers** on `platform.claude.com`. The bridge uses the **Streamable HTTP** transport (`POST /mcp` with `Authorization: Bearer <token>`).

Use the template at `templates/managed-agent/managed-agent-mcp.json` (copy and fill in your values):

```json
{
  "name": "claude-ide-bridge",
  "transport": {
    "type": "http",
    "url": "https://bridge.example.com/mcp",
    "headers": {
      "Authorization": "Bearer YOUR_FIXED_TOKEN"
    }
  }
}
```

`url` must end at `/mcp` — that is the Streamable HTTP MCP endpoint. The bridge does not expose MCP at the root path.

---

## What Works Headless vs What Needs VS Code

The bridge splits into two categories of tools. Managed Agents typically run without a connected VS Code extension, so this distinction matters.

### Works headless (no extension needed)

These tools run on disk + git + shell. No VS Code required.

| Category | Tools |
|---|---|
| Git | `getGitStatus`, `getGitDiff`, `getGitLog`, `gitAdd`, `gitCommit`, `gitPush`, `gitPull`, `gitCheckout`, `gitListBranches`, `gitBlame`, `gitFetch`, `gitStash`, `gitStashList`, `gitStashPop` |
| GitHub | `githubCreatePR`, `githubListPRs`, `githubViewPR`, `githubGetPRDiff`, `githubPostPRReview`, `githubCreateIssue`, `githubListIssues`, `githubGetIssue`, `githubCommentIssue`, `githubListRuns`, `githubGetRunLogs` |
| File I/O | `getBufferContent` (disk fallback), `createFile`, `deleteFile`, `renameFile`, `findFiles`, `getFileTree` |
| Search | `searchWorkspace` (ripgrep), `searchWorkspaceSymbols` (ctags fallback) |
| Shell | `runCommand` (allowlisted commands), `runInTerminal`, `getTerminalOutput` |
| Tests | `runTests` (vitest/jest/pytest/cargo/go test) |
| Project info | `getProjectInfo`, `getProjectContext`, `getDependencyTree`, `getGitHotspots`, `auditDependencies`, `getSecurityAdvisories` |
| LSP (headless) | `goToDefinition`, `findReferences`, `getTypeSignature` — fall back to `typescript-language-server` if installed |
| Diagnostics | `getDiagnostics` — falls back to tsc/eslint CLI when extension not connected |
| Handoff / memory | `getHandoffNote`, `setHandoffNote`, `contextBundle` (partial — no active-editor fields) |
| Bridge meta | `getBridgeStatus`, `getToolCapabilities`, `getActivityLog`, `getPerformanceReport` |

### Requires VS Code extension

These tools only work when a VS Code / code-server instance has the bridge extension connected. They return `isError: true` when the extension is disconnected.

| Category | Tools |
|---|---|
| LSP (full) | `getHover`, `batchGetHover`, `getCallHierarchy`, `getChangeImpact`, `explainSymbol`, `getInlayHints`, `signatureHelp`, `getTypeHierarchy`, `getImportedSignatures`, `batchGoToDefinition`, `batchFindImplementations`, `findImplementations`, `getDocumentSymbols`, `getDocumentLinks`, `foldingRanges`, `selectionRanges`, `getSemanticTokens` |
| Refactor | `refactorAnalyze`, `refactorPreview`, `renameSymbol`, `refactorExtractFunction`, `getCodeActions`, `previewCodeAction`, `applyCodeAction` |
| Debugger | `setDebugBreakpoints`, `startDebugging`, `stopDebugging`, `evaluateInDebugger`, `getDebugState` |
| Editor state | `getOpenEditors`, `getCurrentSelection`, `getHoverAtCursor`, `captureScreenshot`, `setEditorDecorations`, `clearEditorDecorations`, `openFile`, `closeTab`, `saveDocument`, `formatDocument`, `fixAllLintErrors` |
| VS Code tasks | `listVSCodeTasks`, `runVSCodeTask`, `executeVSCodeCommand`, `listVSCodeCommands` |

**To get extension tools in a Managed Agent:** run `code-server` on the VPS with the bridge extension pre-installed, then start the bridge. The extension connects over loopback and all tools become available. See `docs/remote-access.md` Option 1 for the VS Code Remote-SSH approach.

---

## Example: Code Review Agent

A practical Managed Agent that reviews pull requests using bridge tools. See the ready-to-use system prompt at `templates/managed-agent/code-review-agent.md`.

The agent workflow:

```
1. getGitStatus          → identify changed files
2. getGitDiff            → read the full diff
3. getDiagnostics        → TypeScript/lint errors in changed files
4. searchWorkspace       → find related code for context
5. runTests (optional)   → confirm test suite status
6. githubPostPRReview    → post structured review comment to GitHub
```

All six tools work headless — no VS Code extension needed for this workflow.

---

## Limitations

- **Extension tools unavailable** without a co-located VS Code / code-server instance. Managed Agents running in cloud containers cannot reach a developer's local IDE.
- **Headless LSP fallback** requires `typescript-language-server` installed globally on the VPS (`npm install -g typescript-language-server`). Without it, `goToDefinition`/`findReferences` return errors.
- **Ctags fallback** for `searchWorkspaceSymbols` requires Universal Ctags (`ctags --version | grep "Universal Ctags"`). Alpine Docker image: `apk add universal-ctags`.
- **`runCommand` allowlist** — only pre-approved commands execute. Use `--vps` flag to expand the allowlist (adds curl, systemctl, docker, etc.). Interpreter commands (bash, node, python) are permanently blocked.
- **Rate limiting** — default 200 req/min per session. Adjust with `--tool-rate-limit` if the agent is high-frequency.
- **No refresh tokens** — if using OAuth 2.0 mode (vs simple `--fixed-token`), access tokens expire after 24 hours and the client must re-authorize. For Managed Agents, `--fixed-token` is simpler and recommended.
- **Single workspace** — one bridge instance serves one workspace. Multi-workspace requires separate bridge instances on separate ports/domains.

---

## VPS Setup Reference

Full instructions: [`docs/remote-access.md`](../docs/remote-access.md) and [`deploy/README.md`](../deploy/README.md).

Quick path for a new VPS:

```bash
# 1. Bootstrap (installs Node, nginx, certbot, bridge, systemd service)
DOMAIN=bridge.example.com bash <(curl -fsSL \
  https://raw.githubusercontent.com/Oolab-labs/claude-ide-bridge/main/deploy/bootstrap-new-vps.sh)

# 2. Confirm bridge is healthy
curl https://bridge.example.com/health

# 3. Retrieve the fixed token (written to lock file by service)
claude-ide-bridge print-token

# 4. Add the MCP server to your Managed Agent on platform.claude.com
#    URL: https://bridge.example.com/mcp
#    Authorization: Bearer <token from step 3>
```

The bootstrap script generates a random fixed token and stores it in `.env.vps`. Print it with `claude-ide-bridge print-token` or read `.env.vps` directly on the server.
