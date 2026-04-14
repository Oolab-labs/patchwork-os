# Headless / CI Quickstart

Using claude-ide-bridge without VS Code — for CI pipelines, remote servers, and automated workflows.

## What works without the extension

Bridge runs fully headless (no VS Code extension required) for:

| Category | Tools |
|---|---|
| **Diagnostics** | `getDiagnostics` — falls back to tsc, eslint, biome, pyright, ruff, cargo check, go vet |
| **Formatting** | `formatDocument` — falls back to prettier, biome, rustfmt, gofmt, black, ruff |
| **Git** | `getGitStatus`, `getGitDiff`, `getGitLog`, `gitAdd`, `gitCommit`, `gitPush`, `gitBlame`, `gitCheckout`, `gitListBranches`, `gitPull`, `gitFetch`, `gitStash*`, `getDiffBetweenRefs`, `getCommitDetails`, `getGitHotspots` |
| **GitHub** | `githubListPRs`, `githubCreatePR`, `githubViewPR`, `githubGetPRDiff`, `githubListIssues`, `githubCreateIssue`, `githubCommentIssue`, `githubListRuns`, `githubGetRunLogs` |
| **Test runners** | `runTests` — vitest, jest, pytest, cargo test, go test |
| **Terminal** | `runCommand`, `runInTerminal`, `getTerminalOutput`, `sendTerminalCommand`, `listTerminals` |
| **File ops** | `getFileTree`, `findFiles`, `getBufferContent`, `editText`, `createFile`, `renameFile`, `deleteFile`, `searchAndReplace`, `searchWorkspace` |
| **HTTP** | `sendHttpRequest`, `parseHttpFile` |
| **Symbol search** | `getDocumentSymbols` (grep fallback), `searchWorkspace`, `searchWorkspaceSymbols` (with universal-ctags) |
| **Automation** | All hooks (`onFileSave`, `onGitCommit`, `onTestRun`, etc.) |
| **Bridge meta** | `getBridgeStatus`, `bridgeDoctor`, `getToolCapabilities`, `getActivityLog` |

## What requires the VS Code extension

These tools return `isError: true` when the extension is disconnected:

- **LSP tools**: `goToDefinition`, `findReferences`, `getHoverAtCursor`, `getTypeSignature`, `getCallHierarchy`, `getTypeHierarchy`, `getDocumentLinks`, `getInlayHints`, `getCodeLens`, `getSemanticTokens`, `signatureHelp`, `selectionRanges`, `foldingRanges`, `getImportedSignatures`, `getChangeImpact`
- **Refactoring**: `refactorAnalyze`, `refactorPreview`, `renameSymbol`, `refactorExtractFunction`, `prepareRename`
- **Debugger**: `setDebugBreakpoints`, `startDebugging`, `stopDebugging`, `evaluateInDebugger`, `getDebugState`
- **Editor state**: `getOpenEditors`, `getBufferContent` (extension path), `setEditorDecorations`, `clearEditorDecorations`, `captureScreenshot`, `openFile`, `closeTab`, `openDiff`
- **VS Code specific**: `getWorkspaceSettings`, `setWorkspaceSetting`, `executeVSCodeCommand`, `listVSCodeCommands`, `listVSCodeTasks`, `runVSCodeTask`

> **Planned**: `goToDefinition`, `findReferences`, and `getTypeSignature` will gain a headless fallback via `typescript-language-server` in a future release.

## Required probes

Install these to unlock the corresponding headless tools:

```bash
# Git (usually pre-installed)
git --version

# GitHub CLI — for all githubXxx tools
brew install gh        # macOS
sudo apt install gh    # Ubuntu

# Test runners — bridge auto-detects
npm install -g vitest  # or jest
pip install pytest
# cargo and go are checked via PATH

# ripgrep — for searchWorkspace
brew install ripgrep
sudo apt install ripgrep

# Universal Ctags — for searchWorkspaceSymbols headless fallback
brew install universal-ctags
sudo apt install universal-ctags   # NOT: apt install ctags (that's exuberant-ctags)

# typescript-language-server — planned LSP fallback (not yet active)
npm install -g typescript-language-server typescript
```

Run `getBridgeStatus` to see which probes are detected and which tools are available.

## Checking probe status

```json
// Call getBridgeStatus tool
{
  "toolAvailability": {
    "runTests": { "available": true, "probe": "vitest" },
    "getGitStatus": { "available": true, "probe": "git" },
    "githubCreatePR": { "available": false, "probe": "gh" },
    "formatDocument": { "available": true, "extensionFallback": true, "probe": "prettier" }
  },
  "extensionConnected": false
}
```

## GitHub Actions example

```yaml
name: Claude Bridge CI
on: [push, pull_request]

jobs:
  bridge-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      - name: Install bridge probes
        run: |
          sudo apt-get install -y universal-ctags ripgrep
          npm install -g typescript-language-server typescript

      - name: Install and start bridge
        run: |
          npm install -g claude-ide-bridge
          claude-ide-bridge --workspace $(pwd) --port 37100 &
          # Wait for bridge to be ready
          for i in $(seq 1 20); do
            curl -sf http://127.0.0.1:37100/ping && break
            sleep 0.5
          done

      - name: Get bridge token
        run: |
          TOKEN=$(claude-ide-bridge print-token --port 37100)
          echo "BRIDGE_TOKEN=$TOKEN" >> $GITHUB_ENV
          echo "BRIDGE_PORT=37100" >> $GITHUB_ENV

      - name: Run diagnostics check
        run: |
          # Call bridge via MCP HTTP transport
          curl -sf -X POST http://127.0.0.1:$BRIDGE_PORT/mcp \
            -H "Authorization: Bearer $BRIDGE_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"1.0"}}}'
```

## VPS / remote deployment

For VPS deployments (bound to `0.0.0.0`):

```bash
claude-ide-bridge \
  --bind 0.0.0.0 \
  --port 18765 \
  --vps \
  --fixed-token <uuid> \
  --workspace /var/www/myapp
```

See `deploy/` for systemd service templates and nginx reverse proxy configuration.

**Security note for VPS**: All HTTP endpoints (including any future status UI) should be restricted at the nginx/firewall level to trusted IPs for public-facing deployments. The bridge itself validates the Bearer token on all MCP requests but diagnostic endpoints (`/health`, `/metrics`) are unauthenticated.

## Smoke-testing your headless setup

After starting the bridge, verify tool availability:

```bash
# Quick health check
curl -s http://127.0.0.1:37100/health | jq .

# Full bridge status including probe availability
TOKEN=$(claude-ide-bridge print-token --port 37100)
# Then call getBridgeStatus via your MCP client
```

Run `npm run test:smoke` from the bridge repo to validate all categories including headless-compatible categories (git, tools, rate limiting, health).
