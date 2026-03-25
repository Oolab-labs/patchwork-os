# Multi-IDE Parallel Review Workflow

The orchestrator can run two IDE instances simultaneously, enabling a "staged review" pattern where one IDE implements changes and the other reviews them.

## Setup

Start two IDE instances with fixed ports so each gets a distinct lock file:

```jsonc
// ws1/.vscode/settings.json (implementor)
{ "claudeIdeBridge.port": 55000 }

// ws2/.vscode/settings.json (reviewer)
{ "claudeIdeBridge.port": 55001 }
```

Start the orchestrator after both bridges are healthy:

```bash
claude-ide-bridge --orchestrator --port 55100
```

Verify with `getOrchestratorStatus` — both bridges should appear as healthy.

## Workflows

### 1. Staged review: ws1 implements, ws2 reviews

```
# On ws1 — implement the change
editText__Windsurf_55000 / runInTerminal__Windsurf_55000

# Get the diff
getGitDiff__Windsurf_55000

# On ws2 — run diagnostics against the changed files
getDiagnostics__Windsurf_55001
findReferences__Windsurf_55001
getHover__Windsurf_55001
```

This is useful when:
- Reviewing a feature before committing
- Getting a second set of diagnostics (e.g. ws2 has a stricter tsconfig)
- Checking that a refactor didn't break references in a different workspace

### 2. Dual-workspace file comparison

```
getBufferContent__Windsurf_55000  # current file in ws1
getBufferContent__Windsurf_55001  # same path in ws2 (different branch/state)
```

### 3. Cross-IDE terminal isolation

Run a long test suite in ws2 while keeping ws1's terminal free for interactive work:

```
runInTerminal__Windsurf_55001  # run tests in reviewer terminal
runInTerminal__Windsurf_55000  # continue editing in implementor terminal
```

### 4. Parallel git context

```
getGitLog__Windsurf_55000  # ws1 branch history
getGitLog__Windsurf_55001  # ws2 branch history (compare feature vs main)
```

## Tool naming convention

When two bridges share the same IDE name (e.g. both are Windsurf), tools are suffixed with `__<IdeName>_<port>`:

```
openFile__Windsurf_55000   → targets ws1
openFile__Windsurf_55001   → targets ws2
```

When only one bridge uses a given IDE name, the suffix is just `__<IdeName>`:

```
openFile__Windsurf   → targets the single Windsurf instance
```

Call `listWorkspaces` at the start of a session to see the current mapping.

## Sticky affinity

The orchestrator sets sticky affinity on first use: once a session calls a tool on ws1, all subsequent un-suffixed tool calls go to ws1 until `switchWorkspace` is called. Use explicit suffixes to target a specific IDE without disrupting affinity.

## Verifying bridge health

```
getOrchestratorStatus    → JSON with childBridges array, health, tool counts
listWorkspaces           → human-readable workspace list
listBridges              → port/ideName/workspace table
```

If a bridge drops, `getOrchestratorStatus` will show `healthy: false` and the next `probeAll()` cycle (default 60s) will attempt recovery.

## Notes

- Both IDEs must have the claude-ide-bridge extension installed and connected before starting the orchestrator
- The orchestrator's lock file has `orchestrator: true` — the shim prefers it over child bridge locks
- Startup order matters: each bridge → wait for "Extension hello" in logs → then start orchestrator
