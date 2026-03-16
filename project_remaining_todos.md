# Remaining TODOs

Prioritized list of identified-but-not-yet-addressed gaps. Update this file as items are resolved or new ones are found.

---

## High Priority

*(none — all former high-priority items resolved 2026-03-13)*

---

## Medium Priority

*(none — all items resolved)*

---

## Low Priority / Tracking

### 2. JetBrains Plugin
- **What:** Bridge is editor-agnostic but there is no JetBrains extension. Would require a separate Kotlin plugin using the JetBrains Platform SDK.
- **Status:** Not started. Opens a large audience.

### 3. Performance Baseline *(re-confirmed 2026-03-16)*
- Baseline: all representative tools p50=0ms, p99=1ms on loopback. No concerns at current workspace size.
- Re-run after significant tool additions or when workspace grows substantially. Script: `node scripts/benchmark.mjs`

### 4. Pre-existing Lint Issues
These are known and intentionally left alone (not our changes):
- `SUPPORTED_VERSIONS[0]!` in `transport.ts` — noNonNullAssertion (the one remaining pre-existing `!` assertion; others resolved 2026-03-16)
- `smoke-test.mjs`, `activityLog.ts`, `activityLog.test.ts`, `extensionClient.test.ts` — various formatting
- `vscode-extension/vitest.config.ts` — missing `node:` protocol prefix

---

## Resolved *(recent)*

- ✅ **Plugin hot-reload bug hunt** (2026-03-16) — 7 production fixes (empty-prefix guard, stopped flag, in-flight serialisation, per-transport rollback, addTransport ordering, HTTP sessions missing plugins, --plugin-watch warning) + 4 test fixes; 1214 tests
- ✅ **Plugin hot-reload** (2026-03-16) — `--plugin-watch` flag, `PluginWatcher` with fs.watch + 300ms debounce + ESM cache-busting, `replaceTool`/`deregisterToolsByPrefix` on transport; 14 new tests
- ✅ **Correctness sweep** (2026-03-16) — 10 fixes: restoredFiles shared-Set aliasing, pluginLoader collision guard ordering, organizeImports post-op readFileSync, elicitation response detection, safeResult variable, checkpoint mtime vs savedAt, getOpenEditors mutation-during-iteration, gen-claude-md write ordering, entrypoint escape check, scoped npm name generation
- ✅ **Security hardening round 2** (2026-03-16) — 8 fixes: plugin entrypoint path traversal, checkpoint path injection, gen-plugin-stub code injection, install-extension allowlist, resources.ts realpathSync re-check, elicitation prototype pollution, checkpoint future timestamp, automation pattern validation
- ✅ **Persistent session state** (2026-03-16) — openedFiles restored from checkpoint into first connecting session on bridge restart
- ✅ **Plugin system** (2026-03-16) — `--plugin` CLI flag, manifest validation, prefix enforcement, collision detection, authToken exclusion; 26 new tests
- ✅ **`searchAndReplace` integration tests on macOS** (2026-03-16) — `isRgAvailable()` now falls back to checking for the Claude binary; the shim installed in `beforeEach` makes the suite run instead of skip
- ✅ **VS Code Marketplace submission** (2026-03-13) — VSIX published, publisher `oolab-labs`
- ✅ **Hardlink bypass** (2026-03-13) — Added `{ write: true }` to all write-path `resolveFilePath` callers; existing nlink guard now fires correctly
- ✅ **AJV structural validation** (2026-03-13) — Transport validates tool args against `inputSchema` before handler; returns JSON-RPC -32602 on failure
- ✅ **`organizeImports` native fallback** (2026-03-13) — Removed `extensionRequired: true`; falls back to `npx biome` then `npx prettier` when extension disconnected
- ✅ **`tools/list` cursor pagination** (2026-03-13) — Page size 50, base64 opaque cursor, MCP spec SHOULD compliant
- ✅ **`listTasks` fallback** (2026-03-12) — parses `.vscode/tasks.json` + Makefile targets
- ✅ **`watchDiagnostics` fallback** (2026-03-12) — runs detected CLI linters immediately
- ✅ **Multi-session agent team support** (2026-03-12) — up to 5 concurrent AgentSessions, FileLock, terminal namespacing
- ✅ **SSH resilience** (2026-03-12) — grace period, tmux detection, ActivityLog JSONL, SessionCheckpoint, /status endpoint
