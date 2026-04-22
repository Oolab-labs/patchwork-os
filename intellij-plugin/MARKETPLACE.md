# Patchwork Bridge — JetBrains Plugin

Plugin ID: `com.patchwork.bridge`  
Version: `1.0.0`  
Protocol version: `1.1.0`  
Artifact: `build/distributions/patchwork-bridge-1.0.0.zip`

---

## Compatibility

| IDE | Min version | Notes |
|-----|-------------|-------|
| IntelliJ IDEA Community | 2024.1 (build 241) | Tested |
| IntelliJ IDEA Ultimate | 2024.1+ | Untested, should work |
| Android Studio | Iguana (2023.2.1) | build 233 — may need `pluginSinceBuild=233` |
| GoLand, PyCharm, Rider, WebStorm | 2024.1+ | Untested, should work |

`until-build` is open-ended — plugin tracks latest IJ releases.

---

## Prerequisites

1. Patchwork bridge running locally: `npx patchwork start` or `npm start` in the bridge repo
2. Lock file at `~/.claude/ide/<port>.lock` with `isBridge: true`
3. Bridge v0.2.0-alpha.18 or later (protocol `1.1.0`)

---

## Installation

### From zip (dev / sideload)
1. **Settings → Plugins → ⚙ → Install Plugin from Disk…**
2. Select `patchwork-bridge-1.0.0.zip`
3. Restart IDE

### From JetBrains Marketplace (once published)
Search "Patchwork Bridge" in **Settings → Plugins → Marketplace**.

---

## Handler coverage

| Group | Count | Methods |
|-------|-------|---------|
| Core | 23 | getSelection, getOpenFiles, getFileContent, openFile, isDirty, getWorkspaceFolders, getDiagnostics, readClipboard, writeClipboard, saveFile, closeTab, createFile, deleteFile, renameFile, editText, replaceBlock, listTerminals, createTerminal, disposeTerminal, sendTerminalCommand, getTerminalOutput, waitForTerminalOutput, executeInTerminal |
| LSP | 18 | goToDefinition, findReferences, findImplementations, goToTypeDefinition, goToDeclaration, getHover, getCodeActions, applyCodeAction, previewCodeAction, renameSymbol, searchSymbols, getDocumentSymbols, getCallHierarchy, prepareRename, formatRange, signatureHelp, foldingRanges, selectionRanges |
| Debug | 5 | getDebugState, evaluateInDebugger, setDebugBreakpoints, startDebugging, stopDebugging |
| Code style | 3 | formatDocument, organizeImports, fixAllLintErrors |
| **Total** | **49** | |

---

## Platform limitations (stubs)

These 18 methods return `{ "success": false, "error": "Not implemented in JetBrains plugin MVP" }`.

| Method | Reason |
|--------|--------|
| `getAIComments` | Patchwork-specific feature not yet ported |
| `watchFiles`, `unwatchFiles` | IJ VFS listeners exist but bridge doesn't push file events this way |
| `captureScreenshot` | Requires AWT Robot; platform-specific, deferred |
| `listTasks`, `runTask` | Build tool varies per project type (Gradle/Maven/Make); deferred |
| `getWorkspaceSettings`, `setWorkspaceSetting` | IJ settings are structured differently from VS Code's flat key-value model |
| `executeVSCodeCommand`, `listVSCodeCommands` | VS Code-specific; no equivalent command palette API in IJ |
| `getInlayHints` | Requires LSP4IJ or Ultimate; not in Community API |
| `getTypeHierarchy` | TypeHierarchyProvider is UI-only in Community |
| `getSemanticTokens` | Semantic highlighting not exposed as a public API in Community |
| `getCodeLens` | No public CodeLens API in Community |
| `getDocumentLinks` | No public DocumentLink API in Community |
| `setDecorations`, `clearDecorations` | VS Code-specific decoration API; IJ equivalent is RangeHighlighter (deferred) |

---

## IJ-specific behavior differences from VS Code

| Aspect | VS Code | IntelliJ |
|--------|---------|----------|
| `replaceBlock` → `source` field | `"vscode-buffer"` | `"intellij-buffer"` |
| `getTerminalOutput` / `waitForTerminalOutput` | Captures terminal output | Always `{available: false}` — IJ terminal API has no public output buffer |
| `executeInTerminal` | Runs in visible terminal tab | Runs via `GeneralCommandLine` (not visible); output captured |
| `listTerminals` → `isActive` | Reflects active terminal | Always `false` — no reliable activeTerminal API |
| `listTerminals` → `outputCaptureAvailable` | `true` | Always `false` |
| Position convention | 1-based (same) | 1-based on wire, converted to 0-based internally |
| `editText` → `save` default | `false` | `false` (same) |
| `replaceBlock` → `save` default | `true` | `true` (same) |

---

## Publishing checklist

- [ ] Create JetBrains Marketplace account at plugins.jetbrains.com
- [ ] Generate plugin signing certificate: `./gradlew signPlugin`
- [ ] Add signing keys to `gradle.properties` (never commit — use env vars or CI secrets):
  ```
  signing.certificateChain=<base64>
  signing.privateKey=<base64>
  signing.password=<password>
  ```
- [ ] Set publishing token in `gradle.properties`:
  ```
  intellijPlatform.publishing.token=<marketplace token>
  ```
- [ ] Run `./gradlew publishPlugin`
- [ ] Submit for JetBrains review (first publish requires manual approval, ~1–3 days)

---

## Building from source

```bash
cd intellij-plugin
JAVA_HOME=$(brew --prefix openjdk@17) ./gradlew buildPlugin -x buildSearchableOptions
# artifact: build/distributions/patchwork-bridge-1.0.0.zip
```

Run tests:
```bash
JAVA_HOME=$(brew --prefix openjdk@17) ./gradlew test
```
