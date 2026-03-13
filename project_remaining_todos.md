# Remaining TODOs

Prioritized list of identified-but-not-yet-addressed gaps. Update this file as items are resolved or new ones are found.

---

## High Priority

*(none — all former high-priority items resolved 2026-03-13)*

---

## Medium Priority

### 1. `searchAndReplace` Tests Skip in Dev Environment
- **What:** `src/tools/__tests__/searchAndReplace.test.ts` uses `describe.skipIf(!rgAvailable)`. On macOS inside Claude Code, `rg` is a shell function (not a binary), so the suite is silently skipped.
- **Status:** Mitigated (2026-03-12) — added `searchAndReplace.logic.test.ts` which mocks `execSafe` and tests the core replacement logic on all platforms. The original rg-integration suite still gates on binary availability for CI.

---

## Low Priority / Tracking

### 2. JetBrains Plugin
- **What:** Bridge is editor-agnostic but there is no JetBrains extension. Would require a separate Kotlin plugin using the JetBrains Platform SDK.
- **Status:** Not started. Opens a large audience.

### 3. Performance Baseline *(recorded 2026-03-13)*
- Baseline: all representative tools p50=0ms, p99=1ms on loopback. No concerns at current workspace size.
- Re-run after significant tool additions or when workspace grows substantially. Script: `node scripts/benchmark.mjs`

### 4. Pre-existing Lint Issues
These are known and intentionally left alone (not our changes):
- `SUPPORTED_VERSIONS[0]!` in `transport.ts` — noNonNullAssertion
- `smoke-test.mjs`, `activityLog.ts`, `activityLog.test.ts`, `extensionClient.test.ts` — various formatting
- `vscode-extension/vitest.config.ts` — missing `node:` protocol prefix

---

## Resolved *(recent)*

- ✅ **VS Code Marketplace submission** (2026-03-13) — VSIX published, publisher `oolab-labs`
- ✅ **Hardlink bypass** (2026-03-13) — Added `{ write: true }` to all write-path `resolveFilePath` callers; existing nlink guard now fires correctly
- ✅ **AJV structural validation** (2026-03-13) — Transport validates tool args against `inputSchema` before handler; returns JSON-RPC -32602 on failure
- ✅ **`organizeImports` native fallback** (2026-03-13) — Removed `extensionRequired: true`; falls back to `npx biome` then `npx prettier` when extension disconnected
- ✅ **`tools/list` cursor pagination** (2026-03-13) — Page size 50, base64 opaque cursor, MCP spec SHOULD compliant
- ✅ **`listTasks` fallback** (2026-03-12) — parses `.vscode/tasks.json` + Makefile targets
- ✅ **`watchDiagnostics` fallback** (2026-03-12) — runs detected CLI linters immediately
- ✅ **Multi-session agent team support** (2026-03-12) — up to 5 concurrent AgentSessions, FileLock, terminal namespacing
- ✅ **SSH resilience** (2026-03-12) — grace period, tmux detection, ActivityLog JSONL, SessionCheckpoint, /status endpoint
