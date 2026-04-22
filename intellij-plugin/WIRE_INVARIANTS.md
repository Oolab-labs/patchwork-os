# JetBrains Plugin — Wire Compatibility Invariants

**Protocol version:** `1.1.0` (sourced from `src/version.ts` `BRIDGE_PROTOCOL_VERSION`, confirmed matching `EXTENSION_PROTOCOL_VERSION` in `vscode-extension/src/constants.ts`)

---

## 1. Exact Wire Method Names

All methods use the `extension/` namespace. There is no `editor/` or `workspace/` or `clipboard/` namespace on the wire. Any planning doc that says `editor/getSelection` is shorthand only — the wire name is `extension/getSelection`.

### Requests (bridge → plugin, plugin must respond)

| Wire method | MVP disposition | Notes |
|---|---|---|
| `extension/getSelection` | Full impl | no params |
| `extension/getOpenFiles` | Full impl | no params |
| `extension/getFileContent` | Full impl | params: `{ file: string }` |
| `extension/openFile` | Full impl | params: `{ file: string, line?: number }` |
| `extension/isDirty` | Full impl | params: `{ file: string }` |
| `extension/getWorkspaceFolders` | Full impl | no params |
| `extension/getDiagnostics` | Partial (errors only) | params: `{ file?: string }` |
| `extension/readClipboard` | Full impl | no params |
| `extension/writeClipboard` | Full impl | params: `{ text: string }` |
| `extension/saveFile` | Stub | params: `{ file: string }` |
| `extension/closeTab` | Stub | params: `{ file: string }` |
| `extension/getAIComments` | Stub | |
| `extension/createFile` | Stub | params: `{ filePath, content?, isDirectory?, overwrite?, openAfterCreate? }` |
| `extension/deleteFile` | Stub | params: `{ filePath, recursive?, useTrash? }` |
| `extension/renameFile` | Stub | params: `{ oldPath, newPath, overwrite? }` |
| `extension/editText` | Stub | |
| `extension/replaceBlock` | Stub | |
| `extension/listTerminals` | Stub | |
| `extension/getTerminalOutput` | Stub | |
| `extension/createTerminal` | Stub | |
| `extension/disposeTerminal` | Stub | |
| `extension/sendTerminalCommand` | Stub | |
| `extension/executeInTerminal` | Stub | |
| `extension/waitForTerminalOutput` | Stub | |
| `extension/formatDocument` | Stub | params: `{ file: string }` |
| `extension/fixAllLintErrors` | Stub | params: `{ file: string }` |
| `extension/organizeImports` | Stub | params: `{ file: string }` |
| `extension/goToDefinition` | Stub | |
| `extension/findReferences` | Stub | |
| `extension/findImplementations` | Stub | |
| `extension/goToTypeDefinition` | Stub | |
| `extension/goToDeclaration` | Stub | |
| `extension/getHover` | Stub | |
| `extension/getCodeActions` | Stub | |
| `extension/applyCodeAction` | Stub | |
| `extension/previewCodeAction` | Stub | |
| `extension/renameSymbol` | Stub | |
| `extension/searchSymbols` | Stub | |
| `extension/prepareRename` | Stub | |
| `extension/formatRange` | Stub | |
| `extension/signatureHelp` | Stub | |
| `extension/foldingRanges` | Stub | |
| `extension/selectionRanges` | Stub | |
| `extension/watchFiles` | Stub | params: `{ id, pattern }` |
| `extension/unwatchFiles` | Stub | params: `{ id }` |
| `extension/captureScreenshot` | Stub | |
| `extension/listTasks` | Stub | |
| `extension/runTask` | Stub | |
| `extension/getWorkspaceSettings` | Stub | |
| `extension/setWorkspaceSetting` | Stub | |
| `extension/executeVSCodeCommand` | Stub | |
| `extension/listVSCodeCommands` | Stub | |
| `extension/getInlayHints` | Stub | |
| `extension/getTypeHierarchy` | Stub | |
| `extension/getSemanticTokens` | Stub | |
| `extension/getCodeLens` | Stub | |
| `extension/getDocumentLinks` | Stub | |
| `extension/getDocumentSymbols` | Stub | |
| `extension/getCallHierarchy` | Stub | |
| `extension/getDebugState` | Stub | |
| `extension/evaluateInDebugger` | Stub | |
| `extension/setDebugBreakpoints` | Stub | |
| `extension/startDebugging` | Stub | |
| `extension/stopDebugging` | Stub | |
| `extension/setDecorations` | Stub | |
| `extension/clearDecorations` | Stub | |

### Notifications (plugin → bridge, no response)

| Wire method | Buffered across reconnect? |
|---|---|
| `extension/hello` | No — first message on every connect |
| `extension/lspReady` | Yes |
| `extension/diagnosticsChanged` | Yes |
| `extension/fileChanged` | Yes |
| `extension/aiCommentsChanged` | Yes |
| `extension/selectionChanged` | No |
| `extension/activeFileChanged` | No |
| `extension/fileSaved` | No |
| `extension/debugSessionChanged` | No |
| `extension/rttUpdate` | No — stale latency is meaningless |

### Notifications (bridge → plugin, plugin must handle)

| Wire method | Params |
|---|---|
| `bridge/claudeConnectionChanged` | `{ connected: boolean, stats?: { callCount, errorCount, durationMs } }` |
| `bridge/claudeTaskOutput` | `{ taskId, chunk?, done?, status? }` |
| `extension/bridgeLiveState` | `{ contextCachedAt?, preCompactArmed?, debugSessionActive? }` |

---

## 2. Position and Path Conventions

**Line/column:** 1-based. Sourced from `vscode-extension/src/handlers/selection.ts`: `sel.start.line + 1`, `sel.start.character + 1`. No exceptions.

**File paths:** Absolute filesystem paths (not `file://` URIs). The `extension/getSelection` response uses `editor.document.uri.fsPath`. All `file` and `filePath` params throughout handlers expect absolute filesystem paths.

**`extension/getSelection` — no active editor:** Returns `{ "error": "No active editor" }` — not `null`, not a JSON-RPC error, not `{ "success": false }`. This is a result-level object.

**`extension/getOpenFiles` path field:** The field name is `filePath` (not `path`, not `uri`). Shape per item:
```json
{ "filePath": "/abs/path/to/file.kt", "isActive": true, "isDirty": false, "languageId": "kotlin" }
```

**`extension/readClipboard` shape:**
```json
{ "text": "...", "byteLength": 17, "truncated": false }
```
`byteLength` is the original byte length before truncation. Truncated at 100 KB.

**`extension/writeClipboard` shape:**
```json
{ "written": true, "byteLength": 17 }
```
or `{ "written": false, "error": "description" }`. Text > 1 MB returns JSON-RPC `-32602`.

**`extension/getDiagnostics` — two shapes:**
- File-scoped (`file` param present): plain array of diagnostic objects, 1-based line/column.
- Workspace-scoped (no `file` param): `{ "diagnostics": [{ "file": "...", "diagnostics": [...] }], "truncated": false }`. Cap at 500 total; set `truncated: true` when hit.

---

## 3. Active Project Resolution

These rules are JetBrains-specific (VS Code is single-workspace). All handlers snapshot the active project on request arrival and do not re-resolve mid-handler.

| Condition | Resolution |
|---|---|
| Single project open | Use it |
| Multiple projects open | Use last-focused (tracked via `FrameStateListener`) |
| No focused frame / welcome screen / tool window | Use last-focused project if any was ever focused |
| No project at all | Return `{ "success": false, "error": "No project open" }` |
| Focus switches during in-flight request | Use project active at request receipt — snapshot on arrival |
| Null `basePath` (default project) | Treat as no project |

**WorkspaceGuard containment check:**
- Get content roots: `ProjectRootManager.getInstance(project).contentRoots`
- A file is in-scope if its canonical path starts with any content root's canonical path
- Resolve symlinks via `Files.realPath()` before comparison
- MVP single-root exception: if exactly one content root exists, `basePath` is sufficient
- Containment failure: `{ "success": false, "error": "path outside workspace" }`

---

## 4. Connection Lifecycle Invariants

All values sourced from `vscode-extension/src/constants.ts` and `vscode-extension/src/connection.ts`.

| Constant | Value | Source |
|---|---|---|
| `RECONNECT_BASE_DELAY` | 1000 ms | `constants.ts` |
| `RECONNECT_MAX_DELAY` | 30000 ms | `constants.ts` |
| `HANDLER_TIMEOUT` | 30000 ms | `constants.ts` |
| WebSocket open timeout | 30000 ms | `connection.ts` |
| Bridge unresponsive timeout | 120000 ms | `connection.ts` |
| Heartbeat interval | 45000 ms | `connection.ts` |
| Notification buffer cap | 20 items | `connection.ts` |

**Reconnect backoff formula:** `jitteredDelay = round(500 + random() * currentDelay)`, then `currentDelay = min(currentDelay * 2, 30000)`. Resets to `RECONNECT_BASE_DELAY` on successful connect.

**Generation guard:** Each `connect()` call increments a monotonic integer `generation`. Every async callback captures `gen = this.generation` at creation time and silently returns without acting if `gen !== this.generation` when it fires. Required — prevents stale reconnect callbacks from corrupting new connection state.

**Heartbeat / liveness:** Bridge sends WebSocket ping frames every 45 s. Plugin must respond with pong (standard WebSocket behavior). Plugin forces reconnect after 120 s of no pings.

**Notification replay on reconnect:** On successful reconnect, flush buffered notifications in order before processing new messages. Buffer cap 20 items; drop oldest when full. Buffered methods: `extension/diagnosticsChanged`, `extension/fileChanged`, `extension/aiCommentsChanged`, `extension/lspReady`.

**`extension/hello` on connect:** Must be the first message sent after WebSocket open, before any other notifications.
```json
{ "extensionVersion": "1.1.0", "packageVersion": "<plugin-version>", "ideVersion": "<IJ-build-string>" }
```
> ⚠️ **[UNCONFIRMED]** The field name `ideVersion` (replacing VS Code's `vscodeVersion`) must be verified against the bridge before coding. The bridge may ignore this field entirely, or it may validate it. Check `src/server.ts` hello handler before shipping.

---

## 5. `extension/lspReady` Exact Contract

- **Wire method:** `extension/lspReady` (notification — no `id`, no response)
- **Trigger (JetBrains):** `DumbService.getInstance(project).runWhenSmart { ... }` per project on index completion
  > ⚠️ **[UNCONFIRMED]** Confirm `DumbService.runWhenSmart` is the correct hook vs `DumbModeListener.exitDumbMode` — behaviour differs for already-smart projects at startup.
- **Language ID derivation:** Enumerate `FileEditorManager.getInstance(project).openFiles`, call `LanguageUtil.getFileLanguage(vFile)?.id?.lowercase()`, filter nulls, deduplicate into a `Set<String>`. Emit one notification per unique language.
- **Params shape:** `{ "languageId": "kotlin", "timestamp": <epoch-ms> }` — one notification per language, not batched.
- **Deduplication:** Each language sent at most once per session. Track in a `readyLanguages: MutableSet<String>`.
- **Re-sent after reconnect:** Yes — replay all entries in `readyLanguages` on every successful reconnect (these are bufferable methods).

---

## 6. Stub and Error Semantics

| Situation | Response type | Shape |
|---|---|---|
| Known method, not yet implemented | Result | `{ "success": false, "error": "Not implemented in JetBrains plugin MVP" }` |
| Unknown method (not in handler registry) | JSON-RPC error | `{ "code": -32601, "message": "Method not found: <method>" }` |
| Invalid params (missing required field, wrong type) | JSON-RPC error | `{ "code": -32602, "message": "<description>" }` |
| Internal error (exception during handler) | JSON-RPC error | `{ "code": -32603, "message": "<sanitized message>" }` — no stack trace on wire |
| Too many concurrent pending handlers (> 50) | JSON-RPC error | `{ "code": -32000, "message": "Too many pending handlers — try again later" }` |

**Result response wire format:**
```json
{ "jsonrpc": "2.0", "id": <request-id>, "result": <value> }
```

**Error response wire format:**
```json
{ "jsonrpc": "2.0", "id": <request-id>, "error": { "code": -32601, "message": "Method not found: extension/foo" } }
```

`result` and `error` are mutually exclusive. Never send both. Never omit `id` on a response to a request. Never send a response for a notification (a message with no `id`).
