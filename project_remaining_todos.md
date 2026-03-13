# Remaining TODOs

Prioritized list of identified-but-not-yet-addressed gaps. Update this file as items are resolved or new ones are found.

---

## High Priority

### 1. Native Fallback Audit
- **What:** 28 tools have `extensionRequired: true` and are hidden when the extension disconnects. Audit result: most have no viable fallback (terminal, debugger, LSP, decorations, VS Code commands). Three have feasible fallbacks:
  - `listTasks` — parse `.vscode/tasks.json` + Makefile targets *(done, 2026-03-12)*
  - `watchDiagnostics` — runs detected CLI linters immediately, returns snapshot *(done, 2026-03-12)*
  - `organizeImports` — delegate to prettier/biome CLI *(low priority)*
- **Pattern to follow:** Extension-first with native fallback. Remove `extensionRequired: true` from schema when fallback is added.
- **Reference:** `src/tools/clipboard.ts`, `src/tools/getBufferContent.ts` for existing fallback examples.

### 2. Security Research Deferred Items *(from best-practices agent review, 2026-03-12)*
- **Hardlink bypass in `resolveFilePath`** — `realpathSync` resolves symlinks but not hardlinks. A hardlink from inside the workspace to an outside file shares an inode and passes the realpath check. Mitigation would be `fs.lstat` + reject `nlink > 1` on sensitive write paths. High false-positive rate on normal files; low practical risk in the loopback-only local-dev scenario. Track for future evaluation.
- **AJV structural schema validation** — Tool `inputSchema` declares `additionalProperties: false` but nothing enforces it at the handler level. Extra args are silently ignored. An AJV-based pre-validation step in transport could enforce structural completeness without touching individual tools. Deferred pending evidence of real need.
- **`tools/list` cursor pagination** — MCP spec SHOULD-level requirement. Not urgent at 55 tools, but worth implementing if the tool count grows significantly (>100).

---

## Medium Priority

### 3. `searchAndReplace` Tests Skip in Dev Environment
- **What:** `src/tools/__tests__/searchAndReplace.test.ts` uses `describe.skipIf(!rgAvailable)`. On macOS inside Claude Code, `rg` is a shell function (not a binary), so the suite is silently skipped.
- **Status:** Mitigated (2026-03-12) — added `searchAndReplace.logic.test.ts` which mocks `execSafe` and tests the core replacement logic on all platforms. The original rg-integration suite still gates on binary availability for CI.

---

## Low Priority / Tracking

### 4. Performance Baseline *(resolved 2026-03-13)*
- **What:** No profiling had been done on WebSocket backpressure, large file handling, or batch tool call patterns.
- **Baseline recorded 2026-03-13** (50 iterations, loopback, bridge workspace = project root):

  | Tool                | min | p50 | p95 | p99 | max | (ms) |
  |---------------------|----:|----:|----:|----:|----:|------|
  | `tools/list`        |   0 |   0 |   1 |   1 |   1 |      |
  | `getFileTree`       |   0 |   0 |   1 |   1 |   1 |      |
  | `getWorkspaceFiles` |   0 |   0 |   1 |   1 |   1 |      |
  | `searchWorkspace`   |   0 |   0 |   1 |   1 |   1 |      |
  | `getDiagnostics`    |   0 |   0 |   1 |   1 |   1 |      |

  All tools sub-millisecond at p50 and ≤1 ms at p99 on loopback. No backpressure or large-result concerns at this workspace size. Re-run after significant tool additions or when workspace size grows substantially.

### 5. `project_remaining_todos.md` Was Missing
- **What:** CLAUDE.md references this file but it didn't exist, making it impossible to track known issues.
- **Status:** Fixed (this file now exists). Keep it updated.

### 6. Roadmap Version Was Stale
- **What:** `documents/roadmap.md` said "Current State (v1.1.0)" while the project was at v1.3.0.
- **Status:** Fixed (2026-03-12). Updated again to v1.4.2 and 654 tests (2026-03-13).

### 7. Pre-existing Lint Issues
These are known and intentionally left alone (not our changes):
- `SUPPORTED_VERSIONS[0]!` in `transport.ts` — noNonNullAssertion
- `smoke-test.mjs`, `activityLog.ts`, `activityLog.test.ts`, `extensionClient.test.ts` — various formatting
- `vscode-extension/vitest.config.ts` — missing `node:` protocol prefix
