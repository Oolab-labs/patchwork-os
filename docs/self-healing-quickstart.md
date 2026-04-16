# Self-healing quickstart

Five minutes from `npm install` to "I saved a broken file and Claude told me what was wrong without me asking."

This is not a tutorial about writing automation hooks — it's the minimum demo that proves the pattern works. The full example lives in [`examples/self-healing-demo/`](../examples/self-healing-demo/).

**[▶ Watch the 60-second demo](https://github.com/Oolab-labs/claude-ide-bridge/releases/download/v2.42.3/Screen.Recording.2026-04-16.at.15.29.12.mov)**

## Prereqs

- **Node 20+**
- **`claude` CLI** on PATH ([install](https://docs.anthropic.com/en/docs/claude-code))
- A **VS Code–family IDE** (VS Code, Cursor, Windsurf, or `code-server`) with the `claude-ide-bridge` companion extension installed. The extension drives LSP; without it diagnostics don't flow to the bridge.

## 1. Install the bridge

```bash
npm install -g claude-ide-bridge
```

Verify:

```bash
claude-ide-bridge --version   # → 2.42.1 or newer
```

## 2. Install the companion extension

```bash
claude-ide-bridge install-extension
```

The command detects your IDE and installs the VSIX. Restart the IDE once after.

## 3. Grab the demo

```bash
git clone https://github.com/Oolab-labs/claude-ide-bridge.git
cd claude-ide-bridge/examples/self-healing-demo
npm install
```

## 4. Start the bridge with automation

From inside `examples/self-healing-demo/`:

```bash
claude-ide-bridge \
  --workspace "$PWD" \
  --full \
  --automation \
  --automation-policy ./automation-policy.json \
  --claude-driver subprocess
```

Leave this running. You'll see something like:

```
[bridge] listening on 127.0.0.1:55000
[bridge] Automation enabled (policy: ./automation-policy.json)
[bridge] Claude driver: subprocess
```

## 5. Open `src/broken.ts` in your IDE

Open the same folder (`examples/self-healing-demo/`) in VS Code / Cursor / Windsurf and open `src/broken.ts`.

TypeScript will flag two errors. Within ~1 second:

1. The `onDiagnosticsError` hook fires.
2. A Claude subprocess is spawned with the diagnostic contents already embedded.
3. Claude calls `getHover` + related LSP tools to ground the error.
4. A one-sentence root cause + proposed patch appears in the bridge activity log (and the bridge sidebar panel, if open).

To inspect what Claude did, ask Claude (from any connected session):

```
use getActivityLog to show the last 3 automation tasks
```

or watch the bridge's sidebar "Recent Tasks" pane.

## That's it

You saved a file. Claude noticed. Nobody typed a prompt.

## Going further

- **Widen coverage**: edit `automation-policy.json` — `minSeverity: "warning"` to catch lint warnings too.
- **Auto-apply the fix**: add `editText` to the hook's tool whitelist and adjust the prompt. (The demo deliberately doesn't auto-edit — propose-then-apply is safer as a default.)
- **Chain into CI**: wire `onTestRun` (pass) → `githubCreatePR` to close the loop into a real PR.
- **More hooks**: `onGitCommit`, `onBranchCheckout`, `onDebugSessionStart`, `onPullRequest` — full list in [CLAUDE.md § Automation Policy](../CLAUDE.md#automation-policy).

## Why this works

The bridge is an MCP server *and* an event source. Your IDE's language server reports errors to the extension, the extension forwards them to the bridge, the bridge's policy engine decides which events trigger Claude subprocesses, and those subprocesses get the bridge's full tool surface (141 tools including LSP, git, shell, debugger).

Most Claude integrations need a prompt. This one watches the editor and shows up on its own.
