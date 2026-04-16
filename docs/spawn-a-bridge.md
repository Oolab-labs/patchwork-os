# Spawn-a-Bridge

`spawnWorkspace` is an MCP tool that programmatically launches a fresh `claude-ide-bridge` process (and optionally a `code-server` IDE) against a given workspace directory. It is intended for headless deployments — CI runners, VPSes, autonomous agent flows — where a Claude session needs a second isolated workspace to reason about (PR review, parallel tasks, sandboxed explorations).

> **Status:** experimental. The tool is shipped and tested; the surrounding workflow (orchestrator adoption, end-to-end CI demo) is the next chunk of the Spawn-a-Bridge roadmap.

## When to use it

- **PR review in a box**: spin up a bridge + `code-server` on the PR branch, run LSP-grounded review (`findReferences`, `getCallHierarchy`, `getChangeImpact`), tear down.
- **Autonomous multi-workspace agents**: the parent Claude session delegates a subtask to a fresh workspace without forcing the human to open a second IDE.
- **Headless CI**: an Actions job provisions a bridge for the commit under test and a harness asks LSP questions against it.

**Not for:** local desktop workflows. Use `claude-ide-bridge init` + the VS Code extension instead — spawning a desktop IDE from a subprocess is platform-specific and brittle.

## Input

```jsonc
{
  "path": "/abs/path/to/workspace",   // required
  "port": 4567,                        // optional; bridge auto-picks free port
  "token": "hex-token",                // optional --fixed-token
  "timeoutMs": 30000,                  // optional, default 30s
  "waitForExtension": true,            // block until LSP is ready
  "codeServer": true,                  // also spawn code-server
  "codeServerPort": 8080,              // default 8080
  "codeServerBin": "code-server"       // default 'code-server' on PATH
}
```

## Output

On success:

```jsonc
{
  "pid": 12345,
  "port": 4567,
  "workspace": "/abs/path/to/workspace",
  "authToken": "...",
  "lockFile": "/Users/you/.claude/ide/12345.lock",
  "extensionConnected": true,   // only when waitForExtension or codeServer
  "codeServerPid": 12346,       // only when codeServer: true
  "codeServerPort": 8080        // only when codeServer: true
}
```

On failure, `isError: true` with a `code` field:

| Code | Meaning |
|---|---|
| `invalid_arg` | `path` missing/empty/contained null bytes |
| `exec_failed` | Node couldn't spawn the bridge subprocess |
| `code_server_missing` | `codeServer: true` but the binary couldn't be spawned (not on PATH, permission denied, etc.) |
| `timeout` | Lock file didn't appear within `timeoutMs`, or (with `waitForExtension`) the extension never connected |

## Three progressive modes

### 1. Bridge-only (default)

```jsonc
{ "path": "/repo/foo" }
```

Boots the bridge, returns when the lock file exists. LSP/editor tools will not work against this bridge because no VS Code extension has connected.

### 2. Wait for extension handshake

```jsonc
{ "path": "/repo/foo", "waitForExtension": true }
```

Same as above, but after the lock appears the tool polls `GET /health` on the spawned bridge until `extensionConnected: true` (or the shared `timeoutMs` expires). Use this when something external — a running `code-server`, a Remote-SSH session, an already-attached desktop IDE — will connect the extension on its own.

### 3. Bridge + code-server

```jsonc
{ "path": "/repo/foo", "codeServer": true }
```

Same as mode 2, but the tool also spawns `code-server --bind-addr 127.0.0.1:<port> --auth none <path>` so the pre-installed extension can immediately connect. `waitForExtension` is implicit. On handshake timeout both the bridge and code-server are SIGTERM'd.

## Prerequisites for `codeServer: true`

- `code-server` installed and on `PATH` (or absolute path passed via `codeServerBin`).
- The `claude-ide-bridge` VS Code extension pre-installed in code-server's user-data-dir. Standard `code-server --install-extension <vsix>` during image build.
- The spawned bridge's `CLAUDE_CONFIG_DIR` must match the extension's lock-file search path (the default `~/.claude/ide` works out of the box when both run as the same user).

A minimal Dockerfile fragment:

```dockerfile
RUN curl -fsSL https://code-server.dev/install.sh | sh
RUN code-server --install-extension /tmp/claude-ide-bridge.vsix
```

## Remaining roadmap gaps

The following are **not** shipped yet and will be tackled once there's a concrete workflow asking for them:

- **Orchestrator auto-adoption** — the parent Claude session receives `{pid, port, authToken}` but has no built-in way to start *calling tools* against the spawned bridge from within the same session. Options on the table: a `bridgeProxy` tool that forwards calls, or a handoff mechanism that has the orchestrator spawn a second MCP transport.
- **Worked CI example** — a runnable GitHub Actions workflow that spawns a bridge on the PR branch, queries it, and posts a review. Depends on orchestrator adoption.

If you have a concrete workflow for either, file an issue — we'd rather design against a real use case than a hypothetical one.

## See also

- `src/tools/spawnWorkspace.ts` — implementation.
- `src/tools/__tests__/spawnWorkspace.test.ts` — behaviour contract.
- `documents/roadmap.md` — full Spawn-a-Bridge design notes.
