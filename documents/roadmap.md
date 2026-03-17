# Claude IDE Bridge — Roadmap

Development direction and exploration guidance. Living document — update as priorities shift.

---

## Current State (v2.1.35 + post-release fixes — 2026-03-17)

- 135+ MCP tools; 1222+ bridge tests + 370 extension tests, 0 failures; CI green on Node 20 + 22 (Ubuntu)
- Extension v1.0.7 on VS Code Marketplace + Open VSX; installable into VS Code, Windsurf, Cursor, and Antigravity (npm `2.1.35`)
- **Three transports**: WebSocket (Claude Code), stdio shim (Claude Desktop), Streamable HTTP (remote MCP clients)
- Production-grade connection hardening (circuit breaker, backoff, heartbeat, grace period, generation counter)
- Multi-linter and multi-test-runner support (auto-detected)
- GitHub integration (PRs, issues, actions, releases)
- Remote control support via `start-all.sh` orchestrator (tmux, health monitor, exponential backoff)
- Activity logging with Prometheus metrics; session checkpoint every 30s
- Claude Code Platform Integration fully shipped (6 skills, 3 subagents, plugin, hooks, `/ide-monitor`)
- MCP resources (`resources/list` + `resources/read`): workspace-confined, 1 MB cap, cursor-paginated
- MCP elicitation (`elicitation: {}` capability): `McpTransport.elicit()` sends `elicitation/create` to Claude Code 2.1.76+
- Deep security hardening: SSRF three-layer defense, Origin validation, rate limiting, lstatSync everywhere, TOCTOU mitigations, structured error codes
- Claude Desktop + Cowork integration documented; `setHandoffNote`/`getHandoffNote` for cross-session context
- Remote Desktop IDE support: extension runs in remote extension host (SSH/Cursor SSH); `print-token` CLI subcommand for headless VPS setup
- `captureScreenshot` tool: returns MCP image content block directly to Claude (macOS + Linux)
- Full test coverage: all bridge tool files and extension handler files now have unit tests

**Post-v2.1.35 (2026-03-17) — CI fixes + claude.ai web support (no version bump):**
- `scripts/gen-mcp-config.sh`: new `claude-web` target — prints URL/auth/token to paste into claude.ai Settings → Custom Connectors
- `README.md`: new "Use with Claude.ai Web" section with prerequisites, setup command, and token rotation notes
- `biome.json`: added `.claude/worktrees` to ignore list — worktree copies of extension package.json were triggering formatter CI failures
- `vscode-extension/package.json`: biome auto-format (single-item arrays → inline) — was causing CI failures since v1.0.5
- `src/__tests__/bridge-supervisor.test.ts`: 50ms settle delay before SIGTERM — supervisor logs "starting bridge" before spawn(), race was visible on Linux CI
- CI now green on `main` (6776f16)

**v2.1.35 shipped (2026-03-17) — PreToolUse/WorktreeCreate hooks + worktree isolation docs:**
- `claude-ide-bridge-plugin/hooks/hooks.json`: added `PreToolUse` hook (path normalization via `updatedInput`) and `WorktreeCreate` hook (worktree ↔ bridge workspace mapping)
- `claude-ide-bridge-plugin/scripts/pre-tool-use.sh` (new): resolves relative `path`/`filePath`/`uri`/`file` args to absolute paths using the bridge workspace root; skips built-in Claude Code tools; silent no-op when no patch needed
- `claude-ide-bridge-plugin/scripts/worktree-create.sh` (new): same-repo detection via `git rev-parse`; warns about LSP/extension tool limitations in worktree agents
- `docs/worktree-isolation.md` (new): safe vs unsafe tool categories in worktree agents, recommended `disallowedTools` pattern, multi-bridge setup, summary table
- Bridge plugin now has 7 hooks: PreToolUse, PostToolUse, SessionStart, InstructionsLoaded, Elicitation, WorktreeCreate, SubagentStart
- npm `claude-ide-bridge@2.1.35` published; extension unchanged (v1.0.6)

**v2.1.34 shipped (2026-03-17) — Claude Code platform alignment:**
- `claude-ide-bridge-plugin/hooks/hooks.json`: added `InstructionsLoaded` hook (fires on every CLAUDE.md load, not just session start — delivers live bridge status each time Claude refreshes its instructions) and `Elicitation` hook (pre-answers file/path/uri fields in elicitation requests using the active editor, avoiding "which file?" interruptions)
- `claude-ide-bridge-plugin/scripts/instructions-loaded.sh` (new): same status format as `session-info.sh` — port, tool count, extension state, workspace
- `claude-ide-bridge-plugin/scripts/elicitation.sh` (new): reads elicitation schema from stdin, queries bridge `/health` for `activeFile`, returns pre-filled field value or exits silently
- `templates/CLAUDE.bridge.md`: added "Modular rules" section — `.claude/rules/` scoped files + `@import` syntax guidance
- `docs/remote-access.md`: added "Env var expansion" section — `${BRIDGE_TOKEN}` in `.mcp.json` keeps tokens out of config files
- `scripts/gen-mcp-config.sh`: added env var tip to remote target output
- No code changes, no test changes — hooks/scripts/docs only

**v2.1.33 shipped (2026-03-17) — extension disconnect UX, handler correctness, plugin fixes:**
- `transport.ts`: `extensionRequired: true` tools are NO LONGER hidden from `tools/list` when the extension disconnects. They remain always visible. Calling them while disconnected returns `isError: true` with reconnect instructions. The `isExtensionConnectedFn` is now used in the dispatch path (error gate) instead of the list filter.
- `vscode-extension/src/handlers/codeActions.ts`: all `vscode.commands.executeCommand` calls wrapped in try-catch; returns `{ error: msg }` on failure instead of throwing.
- `vscode-extension/src/handlers/lsp.ts`: same try-catch treatment; error shapes return null / empty arrays / `{ applied: false, error }` as appropriate.
- `vscode-extension/src/handlers/screenshot.ts`: replaced `readFileSync` with async `readFile` + 3-attempt retry (50ms apart); unique temp file per call (timestamp + random suffix).
- `vscode-extension/src/bridgeProcess.ts`: `process.kill(pid, 0)` liveness check before connecting to a lock file; dead bridge stale locks skipped immediately.
- `vscode-extension/src/extension.ts`: `deactivate()` logs "Extension deactivating" via output channel.
- `vscode-extension/src/handlers/selection.ts`: returns `{ error: "No active editor" }` instead of `null`.
- `src/pluginLoader.ts`: `BRIDGE_VERSION` now reads from `PACKAGE_VERSION` (was hardcoded `"2.1.23"`).
- `src/index.ts`: `gen-plugin-stub` scaffold now includes `_signal` param.
- `src/tools/handoffNote.ts`: unused `sessionId` param renamed to `_sessionId`.
- Bridge tests: 1222 (unchanged); Extension tests: 369 (↑7 from 362).

**v2.1.32 shipped (2026-03-17) — session persistence correctness & robustness sweep:**
- `sessionCheckpoint.ts`: `CheckpointData` now includes `workspace?: string` field; `loadLatest()` accepts optional `workspace` param and filters checkpoints by workspace — prevents cross-instance contamination when multiple bridge instances share the same `~/.claude/ide/` directory; legacy checkpoints without the field still load (upgrade compat)
- `sessionCheckpoint.ts`: stale checkpoint rejection now emits `console.warn` instead of silently discarding — improves diagnosability on systems with significant clock skew
- `bridge.ts`: workspace passed to `SessionCheckpoint` constructor and `loadLatest()` — ensures checkpoint isolation per workspace
- `claudeOrchestrator.ts`: task file path respects `CLAUDE_CONFIG_DIR` env var instead of being hardcoded to `~/.claude` — consistent with lock file, activity log, and checkpoint path handling
- `handoffNote.ts`: handler enforces 10 000 char limit on `note` content; `updatedBy` is now always `"cli"` (was incorrectly set to the raw session UUID)
- `activityLog.ts`: entries loaded from disk are now type-validated (`status`, `timestamp`, `durationMs` checked) — prevents corrupted on-disk entries from poisoning in-memory state
- 8 new tests (checkpoint workspace filtering: 3, handoff validation: 2, activityLog load validation: 2, orchestrator config dir: 1); 1222 bridge tests total (↑ from 1214)

**v2.1.31 shipped (2026-03-16) — plugin hot-reload bug hunt fixes:**
- `transport.ts`: `deregisterToolsByPrefix("")` empty-prefix guard — prevents accidental wipe of all tools
- `pluginWatcher.ts`: `stopped` flag checked in `scheduleReload` — post-`stop()` timers are no-ops
- `pluginWatcher.ts`: `reloadInFlight` per-spec guard — concurrent reloads for the same plugin are serialised (second reload reschedules rather than racing)
- `pluginWatcher.ts`: per-transport try/catch with rollback — `replaceTool` throw leaves old tools in place instead of split state + unhandled rejection
- `bridge.ts`: `addTransport` moved before `registerAllTools` — closes race where reload fires between the two and new transport never gets patched
- `streamableHttp.ts`: HTTP sessions now receive plugin tools — `getPluginTools` / `getPluginWatcher` callbacks threaded through `StreamableHttpHandler`; HTTP sessions tracked in `PluginWatcher` for live reload
- `config.ts`: warning emitted when `--plugin-watch` is used without `--plugin`
- Tests: false-positive cache-busting test fixed (handlers now called); `timeoutMs` forwarding actually asserted; `FSWatcher.close()` asserted in stop test; zero-transport reload → `getTools()` correctness; `loadPluginsFull` direct coverage; entrypoint path-traversal guard tested; `replaceTool` AJV cache clear proven via schema change; insert path tested; 4 new tests → 1214 total (↑ from 1210)

**v2.1.30 shipped (2026-03-16) — plugin hot-reload:**
- `--plugin-watch` CLI flag (and `pluginWatch: boolean` config key) — re-loads plugins automatically on file change
- `src/pluginWatcher.ts` (new): `PluginWatcher` class with per-plugin `fs.watch()`, 300ms debounce, per-transport `deregisterToolsByPrefix` + `replaceTool`, `getTools()` for new-session correctness, and `stop()` for clean shutdown
- `pluginLoader.ts`: `LoadedPlugin` type (spec + dir + manifest + tools), `loadOnePluginFull()` / `loadPluginsFull()` exported; cache-busting `?t=<timestamp>` import URL prevents Node ESM cache from returning stale module on reload
- `transport.ts`: `replaceTool()` (upsert with AJV cache invalidation) and `deregisterToolsByPrefix()` (bulk remove by prefix)
- Reload safety: failed reload leaves old tools in place; new sessions after reload get fresh tools via `pluginWatcher.getTools()`
- `notifications/tools/list_changed` broadcast after every successful reload
- 14 new tests (pluginWatcher: 8, transport: 3, pluginLoader: 3); 1210 bridge tests (↑ from 1196)

**v2.1.29 shipped (2026-03-16) — correctness sweep:**
- `bridge.ts`: restored `openedFiles` Set now copied (`new Set(captured)`) — sessions no longer share a mutable reference; null-out is atomic with capture (H-1, H-2)
- `pluginLoader.ts`: `existingNames.add()` moved inside `loadOnePlugin` — collision guard correct even if loader is ever parallelised (H-3); entrypoint escape check uses `path.relative` not string prefix (L-2)
- `organizeImports.ts`: both post-operation `readFileSync` calls wrapped in try/catch — graceful error instead of unhandled throw if file deleted after organize (H-4)
- `transport.ts`: elicitation response detection requires `result` or `error` field — malformed requests no longer routed to `pendingElicitations` (M-1); misleading `safeResult` variable removed (M-2)
- `sessionCheckpoint.ts`: `loadLatest` selects newest file by `savedAt` JSON field, not filesystem mtime — correct under file-copy/backup scenarios (M-3)
- `getOpenEditors.ts`: `openedFiles.delete()` deferred until after iteration completes — transiently-unresolvable files no longer permanently evicted (M-4)
- `index.ts`: gen-claude-md writes `.tmp` before backup rename — original intact if write fails (M-6); scoped npm package names (`@org/pkg`) produce valid `name` in generated package.json (L-4)

**v2.1.28 shipped (2026-03-16) — security hardening round 2:**
- Plugin entrypoint path traversal (CRITICAL): `pluginLoader.ts` containment check before `import()` — `startsWith(pluginDir + sep)` guard
- Checkpoint path injection (CRITICAL): `extractRestoredFiles` now calls `resolveFilePath` per file; workspace-escaping paths silently dropped
- `gen-plugin-stub` code injection (HIGH): `--name` format validated `/^[a-zA-Z0-9@._/-]{1,100}$/`; all template interpolations use `JSON.stringify()`
- `install-extension` arbitrary executable (HIGH): `KNOWN_EDITORS` allowlist check for bare editor names before `execFileSync`
- `resources.ts` multi-hop symlink bypass (HIGH): `realpathSync` re-check after `lstatSync` catches ancestor directory symlinks
- Elicitation prototype pollution (MEDIUM): `__proto__` / `constructor` / `prototype` keys rejected in elicitation result handler
- Checkpoint future timestamp bypass (MEDIUM): `savedAt > Date.now() + 5_000` guard in `loadLatest`
- `automation.ts` pattern validation (LOW): `onFileSave.patterns` capped at ≤100 entries × ≤1024 chars each
- `getOpenEditors` fallback path safety (supporting fix): `resolveFilePath` called before `stat()` in native fallback loop
- 1196 bridge tests (↑ from 1195)

**v2.1.27 shipped (2026-03-16) — persistent session state (openedFiles restore):**
- `extractRestoredFiles(checkpoint)` — exported pure function collects union of openedFiles across all checkpoint sessions
- `Bridge.restoredOpenedFiles` — consumed by the first connecting session after restart, then cleared; subsequent sessions start empty
- `Bridge.getPort()` / `Bridge.getAuthToken()` — accessors for test inspection without calling `Bridge.start()`
- Checkpoint log improved: now reports file count and port rather than listing all paths
- 10 new tests in `src/__tests__/bridge-session-restore.test.ts` (5 unit + 5 integration scaffold)
- 1195 bridge tests (↑ from 1185)

**v2.1.26 shipped (2026-03-16) — plugin type exports:**
- `package.json` `exports` map: `"."` → `dist/index.{js,d.ts}`, `"./plugin"` → `dist/plugin.{js,d.ts}`
- `types` field added for tooling that doesn't read `exports`
- `import type { PluginContext } from 'claude-ide-bridge/plugin'` now resolves correctly for TypeScript plugin authors
- No new tests needed — covered by existing typecheck + build

**v2.1.25 shipped (2026-03-16) — plugin developer experience:**
- `gen-plugin-stub <dir> [--name <org/name>] [--prefix <prefix>]` subcommand — scaffolds manifest + `index.mjs` + `package.json` in one command
- `documents/plugin-authoring.md` — full plugin author reference (manifest schema, PluginContext API, tool schema, security model, npm distribution guide)
- Help text updated: all four subcommands now listed under `Subcommands:` in `--help`

**v2.1.24 shipped (2026-03-16) — plugin system + test gap closure:**
- Dynamic plugin loading: `--plugin <path>` CLI flag + `plugins` config file key
- `src/plugin.ts`: public type contract for plugin authors (`PluginContext`, `PluginManifest`, `PluginRegistration`, `PluginSafeConfig`)
- `src/pluginLoader.ts`: manifest validation, `toolNamePrefix` enforcement, cross-plugin collision detection, dedup, error isolation, inline semver check, authToken exclusion from `PluginSafeConfig`
- Transport: `registerTool()` now throws on duplicate name; `ToolSchema` exported
- 20 new pluginLoader tests; 5 new config tests (`--plugin` flag); 1 new transport test (duplicate-name throw)
- 1195 bridge tests (↑ from 1180)

**v2.1.23 shipped (2026-03-16) — extension handler test coverage:**
- 51 tests across 6 previously uncovered extension handler files (clipboard, inlayHints, typeHierarchy, validation, vscodeCommands, workspaceSettings)
- Fixed `__reset()` to also reset `env.clipboard.readText`
- Extension: 362 tests (↑ from 311); Bridge: 1158 tests

**v2.1.22 shipped (2026-03-16) — coverage sweep complete:**
- 38 new tests covering 7 previously untested tools: activityLog, setEditorDecorations, clearEditorDecorations, getCurrentSelection, getLatestSelection, getInlayHints, setActiveWorkspaceFolder, getTypeHierarchy, getWorkspaceSettings, setWorkspaceSetting
- Bridge tool files now have full test coverage

**v2.1.21 shipped (2026-03-16) — 2 correctness fixes:**
- `fileOperations`: `deleteFile` with `useTrash: true` on a directory returned "recursive required" instead of "cannot trash without extension" — useTrash guard now runs before stat()
- `editText`: `applyEditsToContent` now validates that delete/replace edits include both `endLine` and `endColumn`; previously undefined `endColumn` silently produced a zero-width no-op

**v2.1.20 shipped (2026-03-16) — 4 bug fixes (openFile, clipboard, symlink):**
- `openFile`: `startLine` now correctly takes precedence over `startText` in the extension path (was inverted)
- `clipboard`: `truncateToBytes()` uses `Buffer.byteLength` for UTF-8 byte counting (not UTF-16 code units); `writeClipboard` enforces 1 MB server-side before invoking extension
- `utils`: `resolveFilePath` walks ancestor tree to catch symlinks at grandparent levels (e.g. `workspace/link/nonexistent/file.txt`)

**v2.1.19 shipped (2026-03-16) — test coverage round (+83 tests):**
- New test files: editText, fileOperations, cancelClaudeTask/getClaudeTaskStatus/listClaudeTasks, openFile, clipboard
- 1109 bridge tests (↑ from 1026)

**v2.1.18 shipped (2026-03-16) — 8 bug fixes (input validation, cache key, session header, JSON parser):**
- HIGH: `getSecurityAdvisories` cache key used raw `"auto"` not resolved manager; `isValidRef` accepted leading-dash refs (git flag injection); `findFiles` find fallback accepted `-`-prefixed patterns; streamableHttp sent session header in 504 response (client could reuse destroyed session)
- MEDIUM: `searchAndReplace` null byte in non-regex pattern caused misleading output; `vitestJest` JSON fast-path accepted wrong-shaped first match
- LOW: `cargoTest` PANIC regex mis-matched timestamp strings; `httpClient` timeout error name check missed Node <18.14 naming

**v2.1.17 shipped (2026-03-16) — captureScreenshot tool + test coverage:**
- `captureScreenshot`: `screencapture -x` (macOS) / `import -window root` (Linux); returns `{ type: "image", data, mimeType: "image/png" }` MCP image content block
- +72 tests across debug, getDocumentSymbols, fixAllLintErrors, formatDocument, fileWatcher, screenshot
- Bridge: 1017 tests; Extension: 311 tests

**v2.1.16 shipped (2026-03-15) — Remote Desktop IDE support:**
- `extensionKind: ["workspace"]` in extension package.json — loads in remote extension host for VS Code Remote-SSH and Cursor SSH
- `print-token [--port]` CLI subcommand — prints bridge auth token from lock file for headless VPS setup
- `scripts/gen-mcp-config.sh` `remote` target — generates HTTP MCP config from `--host` and `--token` without needing a lock file
- Extension bumped to v1.0.2

**v2.1.15 shipped (2026-03-15) — 2 correctness fixes:**
- Notification off-by-one: `notifCount > 500` → `>= 500` so the 500th notification is the first dropped
- `gitCheckout` detached HEAD: `previousBranch` now returns `null` (was the literal string `"HEAD"`); added `wasDetached: true` and `previousCommit` (12-char hash) for safe navigation back

**v2.1.14 shipped (2026-03-15) — 4 correctness fixes:**
- `getDiagnostics`: pre-aborted caller signal returns `[]` immediately (no subprocess spawned)
- `searchAndReplace`: glob values starting with `-` rejected (rg flag injection prevention)
- `auditDependencies`: resolved manager name used as cache key (`"auto"` + `"npm"` now share one entry)
- `httpClient`: abort forwarder cleaned up from caller signal to prevent listener accumulation

**v2.1.13 shipped (2026-03-15) — 7 security/correctness fixes:**
- CRITICAL: `watchDiagnostics` TDZ ReferenceError when diagnostic update arrived mid-handler
- HIGH (security): `runCommand` `--flag=value` form bypassed dangerous-flag blocklist; `httpClient` user Host header could overwrite IP-pinning Host; terminal Unicode line/paragraph separators (U+2028/U+2029) bypassed newline injection check
- HIGH (correctness): `cargoTest` PANIC regex mis-match; `runTests` noCache eviction race (stale cache clobber); `getSecurityAdvisories` per-severity cache key caused redundant subprocesses
- 28 new regression tests; 937 total

**v2.1.12 shipped (2026-03-15) — template fixes:**
- `templates/CLAUDE.bridge.md`: added "Bug fix methodology" section (write failing test → fix → confirm); corrected stale tool names (`gitStatus` → `getGitStatus`, `gitDiff` → `getGitDiff`)

**v2.1.11 shipped (2026-03-15) — Quick Start accuracy + install-extension npm-global fix:**
- README Step 3: `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude --ide` — env var required for bridge discovery; omitting it silently broke all new users
- `install-extension` subcommand: falls back to marketplace ID when `vscode-extension/` absent (npm-global install); previously crashed with ENOENT
- README tool table: 12 wrong names corrected, 8 phantom tools removed, 8 missing tools added, header 137+→120+
- SETUP.md: labelled as development-mode guide

**v2.1.10 shipped (2026-03-15) — B2 dedup fix + A7 isCommand flag:**
- `getDiagnostics`: `runningPromises` stores `{promise, originSignal}`; aborted-origin entries cleared before dedup; `.finally()` uses reference equality to avoid evicting newer runs
- `sendTerminalCommand`: `isCommand?: boolean` (default `true`) — set `false` for REPL input to bypass shell-command validation

**v2.1.9 shipped (2026-03-15) — debug AbortSignal + watchDiagnostics pre-abort + gen-claude-md:**
- `debug.ts`: `signal?: AbortSignal` threaded through all four tool handlers to extensionClient
- `watchDiagnostics`: synchronous pre-abort check before Promise executor allocates resources
- `gen-claude-md` subcommand + MCP prompt: generates `CLAUDE.md` bridge workflow section; `templates/CLAUDE.bridge.md` ships with npm package

**v2.1.8 shipped (2026-03-15) — persistent task queue:**
- Task queue persists across bridge restarts via `~/.claude/ide/tasks-<port>.json` (v1 envelope)
- `flushTasksToDisk()` synchronous pre-shutdown flush; pending tasks re-enqueued on startup with stable IDs
- Running tasks saved as `"interrupted"` status; `loadPersistedTasks()` handles v0/v1 format + overflow demotion
- 10 new persistence tests; `flushTasksToDisk` called before `cancel()` in shutdown sequence

**v2.1.7 shipped (2026-03-15) — 8 tools-layer bug fixes:**
- `searchAndReplace`: per-file `new RegExp(regex.source, regex.flags)` — eliminates `lastIndex` race in `Promise.all`
- `getDiagnostics`: `linterErrors.delete(linter.name)` on success; `linterErrors: {}` on all response paths
- `runTests`: `runningPromises.delete(key)` in `noCache` block alongside `caches.delete`
- `watchDiagnostics`: re-check timestamp after `addDiagnosticsListener` to close TOCTOU window
- `gitWrite`: post-commit `git diff-tree --no-commit-id -r --name-only HEAD` for accurate file list; blame parser `!currentHash` guard
- `fileOperations`: hardlink cleanup on `unlink` failure in native rename fallback
- `terminal.ts`: `timeoutMs` raised to 310 000 ms on `waitForTerminalOutput` + `runInTerminal`

**v2.1.6 shipped (2026-03-15) — schema/description QoL fixes:**
- `getDiagnostics`: `linterErrors` always present (empty `{}` when clean); removed conditional spread
- `getFileTree`: schema description documents skipped dirs (node_modules, .git, dist, etc.)

**v2.1.2–v2.1.5 shipped (2026-03-15) — getSecurityAdvisories cargo + pip-audit:**
- `runCargoAudit()`: `cargo audit --json` parser; RUSTSEC advisory format; patched versions as fix hint
- `runPipAudit()`: `pip-audit --format=json` parser; per-dep multi-vuln expansion; PYSEC IDs
- `detectAuditor()`: Cargo.toml → cargo; requirements.txt / pyproject.toml → pip
- Schema enum: `auto/npm/yarn/pnpm/cargo/pip`; ENOENT install hints for both tools
- 8 new tests (cargo: 3, pip: 4, no-manifest: covered); 926 bridge tests total

**v2.1.1 shipped (2026-03-15) — getSecurityAdvisories yarn/pnpm parity:**
- `runYarnAudit()`: JSONL `auditAdvisory` event parsing for `yarn audit --json`
- `runPnpmAudit()`: same npm v7 JSON shape via `pnpm audit --json`
- `detectAuditor()`: lock-file priority pnpm > yarn > npm (parity with `auditDependencies`)
- Shared `parseNpmAuditJson()` helper; schema enum updated to `auto/npm/yarn/pnpm/cargo/pip`
- 4 new tests; 909 bridge tests total

**v2.1.0 shipped (2026-03-15) — Phase 3: /stream SSE + yarn/pnpm audit + CI hardening:**
- `GET /stream`: SSE endpoint for real-time activity log push (Bearer auth, keep-alive pings, per-connection unsubscribe)
- `activityLog.subscribe()`: listener/unsubscribe pattern; disk I/O converted to async fire-and-forget
- `auditDependencies`: yarn 1.x (JSONL table-event) + pnpm support; lock-file detection order
- CI: loose 500ms PR threshold; strict 100ms on main only; `publish-extension.yml` workflow fixed
- Extension v0.9.9 / v1.0.0 (VS Code Marketplace); bridge v2.1.0; 905 tests

**v2.0.9 shipped (2026-03-15) — P2/P3 code review fixes:**
- Double `list_changed` broadcast eliminated; `callCount`/`errorCount` stat skew fixed
- `activityLog` async disk I/O; `generateAPIDocumentation` O(N²) + regex backtracking fixes
- `resources.ts` MAX_WALK_DEPTH=20; CORS `corsOrigin()` http-only; 897 tests

**v2.0.8 shipped (2026-03-15) — Supervisor mode + serverInfo meta + Cowork UX:**
- `--watch` flag: self-supervising wrapper with exponential backoff (2s→30s, SIGTERM-safe)
- `serverInfo._meta.packageVersion` in MCP `initialize` response (disambiguates protocol vs package version)
- `/cowork` prompt: two-step handoff framing, `setHandoffNote` template, Cowork MCP gap warning
- CI matrix expanded to Ubuntu + Windows × Node 20 + 22; 873 tests

**v2.0.7 shipped (2026-03-15) — Security hardening + critical/major/minor bug fixes:**
- CORS lockdown, lockfile TOCTOU fix, concurrent tool call routing, atomic checkpoints
- Elicitation validation, OTel coordination, DebugState safe extraction, resources URI decoding
- Extension fixes: terminal handler, events readyState, clearAllTerminalBuffers guard; 864 tests

**v2.0.6 shipped (2026-03-15) — 8-gap remediation:**
- E2E integration tests, per-session rate limiting, `/ping` endpoint, untrusted workspace gate
- Windows CI matrix, `claudeDriver.ts` unit tests, `extension.ts` unit tests; 864 tests

**v2.0.5 shipped (2026-03-15) — Extension auto-installs and auto-starts bridge:**
- `BridgeInstaller`, `BridgeProcess`, `connectDirect()` — install extension → done

**v2.0.1 shipped (2026-03-14) — Desktop reliability + cross-session handoff:**
- Lock file now includes `isBridge: true`; stdio shim `findLockFile()` prefers bridge locks over IDE-owned locks — fixes auto-discovery collision when Windsurf (or any other IDE) writes its own lock file to `~/.claude/ide/`
- New tools: `setHandoffNote` / `getHandoffNote` — file-backed (`~/.claude/ide/handoff-note.json`), shared across all MCP sessions; enables context handoff between Claude Desktop and Claude Code CLI
- **Shim lock-file watcher**: `fs.watch(~/.claude/ide/)` in auto-discover mode — shim reconnects automatically when bridge restarts on a new port; Claude Desktop no longer needs a full quit+relaunch on bridge restart
- 4 new tests in `src/tools/__tests__/handoffNote.test.ts`

**v2.0.0 shipped (2026-03-14) — Streamable HTTP + Claude Desktop:**
- New transport: `src/streamableHttp.ts` — MCP Streamable HTTP spec (POST/GET/DELETE /mcp), SSE server push, session management (30min TTL, max 5)
- `HttpAdapter` class bridges HTTP request/response into WebSocket-like interface so `McpTransport.attach()` works unchanged
- Claude Desktop integration: `scripts/gen-claude-desktop-config.sh` writes stdio shim config; verified end-to-end
- `docs/remote-access.md`: Caddy/nginx reverse proxy setup, TLS, endpoint reference
- Security headers: `X-Content-Type-Options: nosniff` + `Cache-Control: no-store` on all responses
- 22 new tests in `src/__tests__/streamableHttp.test.ts` (828 total)
- Published: npm `claude-ide-bridge@2.0.0` ✅; Open VSX extension v0.9.0 ✅; tagged v2.0.0 on GitHub ✅

**v1.9.0 shipped (2026-03-14) — Claude Code 2.1.76+ compatibility:**
- Elicitation: `McpTransport.elicit()`, `elicitation: {}` in `initialize` capabilities and server card
- Automation: `OnPostCompactPolicy` (re-snapshot IDE state after compaction) + `OnInstructionsLoadedPolicy` (inject tool summary at session start) — both fire via Claude Code 2.1.76+ hooks
- `model` param on `runClaudeTask` + `resumeClaudeTask` (passed as `--model` to SubprocessDriver)
- `set-effort` MCP prompt: 6th slash command (low/medium/high effort instruction)
- `start-all.sh`: `--name bridge:<workspace>` session display; `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=10000`
- `--config` path length bound (4096 chars); `notifCount` reset comment; `CLAUDE_CODE_REMOTE` guard documented

**v1.8.0 shipped (2026-03-14) — Security hardening:**
- 13 security findings resolved across 3 High / 6 Medium / 3 Low / 1 Info
- `lstatSync` everywhere (symlink bypass prevention); walk cache TTL (5s) for resources
- Rate-limit-on-reconnect fix (no reset on `detach()`); hardlink guard via `{ write: true }` path
- `resumeClaudeTask` tool: re-enqueue completed/failed tasks preserving prompt + context
- httpClient SSRF guard (RFC 1918, link-local, CGNAT, hex IP); gitPush force-push blocked on main/master
- Structured `ToolErrorCodes` in `src/errors.ts`
- Extension: `syncInProgress` guard against concurrent `makeConnection` calls

**v1.7.0 shipped (2026-03-14) — Best Practices Hardening:**
- Tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on all tools
- Lock file `chmod 600`; health monitor exponential backoff (5s→300s)
- `/.well-known/mcp/server-card.json` + `/.well-known/mcp` (MCP registry discovery, SEP-1649)
- OpenTelemetry: `src/telemetry.ts` wraps every tool call; activate via `OTEL_EXPORTER_OTLP_ENDPOINT`
- Token-aware concurrency: `MAX_TOKEN_BUDGET=500K` alongside `MAX_CONCURRENT=10`
- Task persistence to `~/.claude/ide/tasks-<port>.json`; `resumeClaudeTask` re-enqueues by ID
- Extension: `LogOutputChannel` (structured log levels); SecretStorage fallback for auth token

**v1.6.0 shipped (2026-03-14):**
- Claude Code Server Mode Integration: `claudeDriver.ts`, `claudeOrchestrator.ts`, `automation.ts`; 4 MCP tools; `GET /tasks`; `onDiagnosticsError` + `onFileSave` automation policies
- MCP Prompts: 5 slash commands (`review-file`, `explain-diagnostics`, `generate-tests`, `debug-context`, `git-review`)
- getDiagnostics hardening: control char stripping + 500-char cap on message text

---

## Claude Code Server Mode Integration *(Shipped — v1.6.0)*

The bridge can now spawn Claude subprocesses, queue tasks, and drive event-driven automation.

- `src/claudeDriver.ts`: `IClaudeDriver` interface + `SubprocessDriver` (spawns `claude -p`) + `ApiDriver` stub
- `src/claudeOrchestrator.ts`: Task queue with `MAX_CONCURRENT=10`, `MAX_QUEUE=20`, `MAX_HISTORY=100`. Exposes `enqueue()`, `runAndWait()`, `cancel()`, `list()`, `getTask()`
- `src/automation.ts`: `AutomationHooks` + `loadPolicy()` — handles `onDiagnosticsError` and `onFileSave` with cooldown and loop guard
- 4 new MCP tools: `runClaudeTask`, `getClaudeTaskStatus`, `cancelClaudeTask`, `listClaudeTasks` (session-scoped; only visible when `--claude-driver != none`)
- `GET /tasks` HTTP endpoint (Bearer-auth) for external monitoring
- VS Code output channel receives streamed Claude output in real time (`bridge/claudeTaskOutput` push notification)
- New CLI flags: `--claude-driver`, `--claude-binary`, `--automation`, `--automation-policy`
- Security: 32 KB prompt cap, `CLAUDECODE` env stripped from subprocess, workspace path confinement on context files, diagnostic message sanitization with delimiters
- **Bug fixes (2026-03-14 live test)**: Removed bogus `--workspace` flag from `claude -p` spawn args (flag doesn't exist in the CLI); added `stdio: ['ignore', 'pipe', 'pipe']` to prevent subprocess blocking on open stdin pipe; stripped all `CLAUDE_CODE_*` + `MCP_*` env vars from subprocess to prevent attaching to parent session ingress; added `--strict-mcp-config` to suppress `.mcp.json` auto-discovery in the workspace

---

## MCP Prompts *(Shipped — v1.6.0)*

5 built-in slash commands surfaced via the MCP `prompts` capability:

- `review-file` — code review using current diagnostics for a file
- `explain-diagnostics` — plain-English explanation + fix suggestions for all errors in a file
- `generate-tests` — test scaffold for exported symbols in a file
- `debug-context` — snapshot current debug state, editors, and diagnostics
- `git-review` — review all changes since a base branch (default: `main`)

Implemented in `src/prompts.ts`. No extension required. Transport handles `prompts/list` and `prompts/get` with the same cursor-pagination and validation as `tools`.

---

## Claude Code Platform Alignment (Shipped — v2.1.34–35)

Research (2026-03-17) against current Claude Code docs revealed gaps between the bridge's platform integration and what's now available. All items shipped.

### Shipped (v2.1.34)
- **`gen-claude-md` template** — `.claude/rules/` modular scoping and `@import` syntax documented
- **Env var expansion** — `${VAR:-default}` in `.mcp.json` documented in `docs/remote-access.md`
- **`InstructionsLoaded` hook** — live bridge status injected every time CLAUDE.md loads
- **`Elicitation` hook** — pre-answers file/path/uri fields using the active editor

### Shipped (v2.1.35)
- **`PreToolUse` hook with `updatedInput`** — resolves relative path args to absolute before bridge tools execute
- **`WorktreeCreate` hook** — reports bridge ↔ worktree relationship; warns about LSP tool limitations
- **`docs/worktree-isolation.md`** — safe vs unsafe tool categories, `disallowedTools` pattern, summary table

### Remaining (deferred)
- Verify Tool Search compatibility — with 135+ tools active; low priority (automatic, no bridge changes needed)
- Agent Teams — when Claude Code's multi-session Teams feature ships; plan session namespacing then

---

## Near-Term Exploration Areas

### Multi-Editor Support *(baselined)*
- Architecture is editor-agnostic (bridge doesn't import vscode)
- Extension installable into VS Code, Windsurf, Cursor, and Antigravity via `install-extension` command
- Auto-detection and name mapping for all four editors tested and passing
- JetBrains: no extension yet — would require a separate plugin (different extension API)

### Native Fallback Improvements *(complete)*
- Currently: extension disconnect → tools remain visible; calling them returns `isError: true` with reconnect instructions (changed in v2.1.33 — previously hid 27 tools)
- `listTasks` fallback shipped — parses `.vscode/tasks.json` + Makefile targets
- `watchDiagnostics` fallback shipped — runs detected CLI linters immediately, returns snapshot
- `organizeImports` fallback shipped — biome → prettier chain; 3 tests covering both CLI paths and the "no CLI available" error
- All others (terminal, debugger, LSP, decorations, VS Code commands) have no viable fallback — intentionally `extensionRequired`

### Test Coverage *(complete — 2026-03-17)*
- 1222+ bridge tests + 369 extension tests, 100 files; 0 failures
- Integration tests: 6 files, full WebSocket round-trip coverage
- All bridge tool files and extension handler files now have unit tests
- `searchAndReplace` rg-integration suite now runs on macOS (Claude binary shim) in addition to Linux CI; mocked-rg logic suite runs on all platforms

### Performance *(CI-gated 2026-03-14; sustained-load closed 2026-03-16)*
- Benchmark script: `node scripts/benchmark.mjs [--json] [--threshold <ms>]`
- CI runs benchmark on every push to main: 100 iterations, p99 > 100ms = build failure
- Baseline (50 iterations, loopback): all tools p50=0ms, p99=1ms — at Node.js timer resolution floor; confirmed for `searchWorkspace×200` and `getBufferContent` disk-path scenarios
- Benchmark results archived as GitHub Actions artifacts (30-day retention) for trend analysis
- `getBufferContent` large-file bug fixed (2026-03-16): size cap was checked before slicing — `startLine`/`endLine` params silently failed on files >512KB despite the error message instructing users to use them. Fixed via `stat()` + readline streaming for large files with a range; no-range requests on large files still error as before.

### Multi-Workspace Support *(shipped 2026-03-14)*
- Extension now connects to one bridge per VS Code workspace folder in multi-root workspaces
- `readAllMatchingLockFiles()` returns all valid lock files matching open workspace folders
- `BridgeConnection.workspaceOverride` scopes each connection to its workspace
- `registerEvents` broadcasts all VS Code events to all connected bridges
- Status bar shows aggregate state: "N/M connected"
- Workspace folder changes (add/remove) automatically create/dispose connections
- Non-VS Code editors (JetBrains, Neovim): not yet supported; WebSocket protocol documented in data-reference.md for community adapters

---

## Claude Code Platform Integration (NEW)

### Skills & Slash Commands (Shipped)
- 5 pre-built skills in `.claude/skills/`: `/ide-debug`, `/ide-review`, `/ide-quality`, `/ide-refactor`, `/ide-explore`
- Package existing use-case workflows as one-command invocations
- `disable-model-invocation: true` for action skills, `context: fork` for exploration
- Skills reference bridge MCP tools by name — no bridge code changes needed

### Custom Subagents (Shipped)
- 3 subagent definitions in `.claude/agents/`: `ide-code-reviewer`, `ide-debugger`, `ide-test-runner`
- Each uses bridge MCP tools in isolated context
- `memory: project` enabled for cross-session learning
- Subagents produce verbose output (LSP queries, terminal logs) that stays out of main context

### Plugin Packaging (Shipped)
- Full plugin in `claude-ide-bridge-plugin/`: manifest, skills, agents, hooks, MCP config, README
- Load with `claude --plugin-dir ./claude-ide-bridge-plugin`
- Includes 6 skills, 3 agents, 3 hooks, MCP server config
- Ready for marketplace distribution when bridge is published to npm

### Hook Integration (Shipped)
- `PostToolUse` on Edit/Write → reminds Claude to check diagnostics after edits
- `SessionStart` → reports bridge status, connection, tool count
- `SubagentStart` on ide-* agents → verifies bridge health before subagent runs
- All hooks in `claude-ide-bridge-plugin/hooks/hooks.json` with scripts in `scripts/`

### Scheduled IDE Monitoring (Shipped)
- `/ide-monitor` skill with 3 modes: diagnostics, tests, terminal
- Use with `/loop` for recurring checks: `/loop 5m /claude-ide-bridge:ide-monitor diagnostics`
- Session-scoped (requires active Claude Code session)

### Headless/Agent SDK Integration (Documented)
- Bridge MCP enables `claude -p` (headless mode) to have IDE capabilities
- CI/CD examples documented in plugin README
- Already works via `--mcp-config` pointing to bridge

### Agent Team Support
- Claude Code's experimental Agent Teams: multiple sessions sharing one bridge
- 3-5 agents working in parallel (security review + test fixing + PR creation)
- Requires: multi-session safety, file edit coordination, terminal namespacing
- Aligns with existing "Collaborative Features" roadmap item

### Visual Output Skills
- Skills that generate interactive HTML using bridge data
- Dependency graphs from `getCallHierarchy` + `findReferences`
- Test coverage heatmaps, diagnostic dashboards
- Follows Claude Code's codebase-visualizer pattern

---

## Medium-Term Possibilities

### Plugin Hot-Reload *(Shipped — v2.1.30)*
- `--plugin-watch` flag triggers `PluginWatcher` which monitors each plugin directory with `fs.watch()`
- 300ms debounce coalesces rapid editor saves into a single reload
- ESM cache-busting via `?t=<timestamp>` query param on dynamic `import()`
- Failed reload keeps old tools in place; `notifications/tools/list_changed` sent on success

### Plugin System *(Shipped — v2.1.24)*
- `--plugin <path>` CLI flag + `plugins` config file key
- `claude-ide-bridge-plugin.json` manifest: `schemaVersion`, `name`, `entrypoint`, `toolNamePrefix`, `minBridgeVersion`
- `PluginContext` passed to `register(ctx)`: `workspace`, `workspaceFolders`, `config` (`PluginSafeConfig` — no authToken), `logger`
- Accepts named `export function register()` or default export
- Collision detection, dedup, prefix enforcement, per-plugin error isolation

### Persistent Session State *(Shipped — v2.1.27; correctness fixes in v2.1.32)*
- `openedFiles` restored from checkpoint on restart — first connecting session is seeded with the union of all previously-tracked files
- Checkpoint data is now workspace-scoped (`workspace` field in `CheckpointData`) — multiple bridge instances no longer cross-contaminate each other's checkpoints
- All persistence paths (`checkpoint`, `activity log`, `task queue`) respect `CLAUDE_CONFIG_DIR` env var
- Activity log entries are type-validated on load from disk; `handoffNote.updatedBy` is always `"cli"` (stable, not a session UUID)
- Activity log already persisted to disk (v2.0.x); diagnostics are live from extension/CLI (no cache to restore)
- Task queue already persisted (v2.1.8)

### Multi-Workspace Bridging
- One bridge instance serving multiple workspaces
- Currently: one bridge per workspace
- Challenges: tool scoping, lock file format changes, workspace isolation

### Collaborative Features
- Multiple Claude Code sessions sharing one bridge
- Coordination of file edits (optimistic locking?)
- Shared activity log visible to all sessions

---

## Architectural Constraints

These cannot change without breaking compatibility:

| Constraint | Value | Why |
|-----------|-------|-----|
| Lock file location | `~/.claude/ide/<port>.lock` | Claude Code CLI reads this path |
| Lock file format | `{ authToken, pid, workspace, ideName, isBridge: true }` | Contract with Claude Code; `isBridge` added for shim auto-discovery |
| MCP protocol version | `2025-11-25` | Must stay compatible with Claude Code's MCP client |
| Extension API | VS Code `^1.93.0` | Minimum supported VS Code version |
| Node.js | `>=20` | Uses modern APIs (crypto.randomUUID, etc.) |
| Tool name format | `/^[a-zA-Z0-9_]+$/` | MCP protocol requirement |

---

## Round Proposal Template

When proposing a new development round:

```markdown
## Round N: <Name>

### Problem
What issue or gap does this round address?

### Scope
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

### Affected Files
- `src/...`
- `vscode-extension/src/...`

### Test Plan
How will we verify correctness?

### Rollback Strategy
How do we revert if something goes wrong?

### Dependencies
What must be completed first?
```
