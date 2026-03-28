# Changelog

All notable changes to claude-ide-bridge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.6.3] — 2026-03-28

### Added
- **Jujutsu (`.jj`) and Sapling (`.sl`) VCS exclusions** — `getFileTree` and `findFiles` now skip `.jj` and `.sl` directories alongside `.git`, preventing descent into VCS internals for repos using these newer version control systems.
- **`X-Claude-Code-Session-Id` header correlation** — HTTP sessions (Streamable HTTP transport) now read the `X-Claude-Code-Session-Id` header sent by Claude Code 2.1.86+. The value is stored on the session and propagated to the transport's tool-call spans as `claude.session.id`, so proxy logs and bridge logs can be correlated by session without parsing request bodies.
- **Automation policy summary in `getBridgeStatus`** — When automation is enabled, `getBridgeStatus` now includes an `automation` field reporting the enabled/disabled state of `onPostCompact`, `onDiagnosticsError`, and `onFileSave` hooks. For `onPostCompact` the configured `cooldownMs` is also surfaced, useful for diagnosing unexpected compaction behavior given Claude Code's new configurable `autoCompactThreshold`.

---

## [2.6.1] — 2026-03-26

### Added
- **`shim` subcommand** — `claude-ide-bridge shim` is an stdio relay that auto-discovers the running bridge or orchestrator via lock file and connects Claude Code to it. Replaces the hardcoded path to `scripts/mcp-stdio-shim.cjs`. Add once to `~/.claude.json` and bridge tools are available in every `claude` session regardless of working directory:
  ```json
  { "mcpServers": { "claude-ide-bridge": { "command": "claude-ide-bridge", "args": ["shim"] } } }
  ```

### Changed
- **`init` subcommand** — Now automatically registers the `claude-ide-bridge shim` MCP server in `~/.claude.json` as step 3. After running `init`, bridge tools are available in all `claude` sessions without any manual config.

### Fixed
- **Orchestrator 0-tools bug** — When a child bridge responded to `/ping` but `listTools()` returned empty (HTTP session init failed silently), the bridge was incorrectly marked healthy with 0 tools, causing the orchestrator to expose no proxied tools to Claude. The bridge now stays in the warming state and retries on the next health cycle.

---

## [2.6.0] — 2026-03-25

### Breaking Change
- **Slim mode is now the default** — The bridge registers 27 IDE-exclusive tools by default instead of all ~95. Pass `--full` to restore git, terminal, file ops, HTTP, and GitHub tools. Plugin tools always bypass the slim filter. Existing users who rely on git/terminal/file tools via the bridge must add `--full` to their startup command (or in `start-all.sh`).

### Added
- **`init` subcommand** — One-command setup: auto-detects editor, installs the VS Code extension, writes/appends to `CLAUDE.md`, and prints numbered next steps. Replaces the 4-step manual Quick Start.
- **`SLIM_TOOL_NAMES` export** — `Set<string>` of the 27 slim tools exported from `src/tools/index.ts` for introspection and testing.
- **`--full` flag** — Opt-in to register all ~95 tools (git, terminal, file ops, HTTP, GitHub).
- **`start-all.sh --full`** — Passthrough flag; also prints a prominent slim mode warning in pane 0 when running without `--full`.
- **Startup banner** — Now prints tool mode (slim/full) with `--full` hint when in slim mode.
- **9 new tests** in `src/tools/__tests__/slimMode.test.ts` covering `SLIM_TOOL_NAMES` invariants, `parseConfig --full`, registration filtering, and plugin bypass.

### Changed
- **README Quick Start** — Reduced from 4 manual steps to 3 lines using `init`.
- **README MCP Tools section** — Replaced 70-line wall-of-text with two-table slim/full layout.
- **Multi-IDE Orchestrator section** — Added "when to use" gate (50k+ lines) and "where not worth it" guidance.
- **ICPs.md** — Added Persona 6: Multi-IDE Orchestrator User.
- **`package.json` repository URL** — Normalized to `git+https://...git` form.

---

## [2.5.17] — 2026-03-25

### Changed
- **`switchWorkspace` response** — Now reports the `wsN` alias (`Active workspace: ws1 — /path (IDE)`) so Claude knows which alias prefix corresponds to the active bridge. Disambiguation message condensed; error messages use tighter phrasing.
- **`getOrchestratorStatus` output** — Replaced pretty-printed JSON blob with a compact line-oriented format (`sessions=N`, `[healthy]`/`[warming]`/`[unhealthy]` per bridge). Saves ~500–800 bytes per call.

---

## [2.5.16] — 2026-03-25

### Changed
- **Lazy tool exposure in multi-bridge mode** — When two or more IDE bridges are healthy, the orchestrator now exposes only the active bridge's tools at session connect time (instead of all bridges' tools combined). The active bridge is pre-selected via `pickBest()` and stored as the session's sticky bridge. Calling `switchWorkspace` swaps the exposed tools to the new bridge and sends `notifications/tools/list_changed`. This reduces tool count from `N × 136` to `136` in all cases.
- **`McpTransport.deregisterTool(name)`** added — removes a single tool by name (used by the lazy swap path to drop tools exclusive to the previous bridge).

---

## [2.5.15] — 2026-03-25

### Changed
- **Description prefix compression** — In single-bridge mode, proxied tool descriptions no longer include the `[IdeName: workspace]` prefix (saves ~15 KB per `tools/list` response). In multi-bridge mode, the full path prefix is replaced with a compact alias (`[ws1]`, `[ws2]`) matching the workspace index in the session instructions.
- **Compact session-start instructions** — `buildInstructions()` now emits a structured format (`WORKSPACES:`, `MULTI-IDE:`, `CAUTION:`, `RULE:`) instead of prose. Adds `RULE: do NOT call getOrchestratorStatus/listWorkspaces/listBridges at session start` to prevent redundant status calls on every new session.

---

## [2.5.14] — 2026-03-25

### Fixed
- **Proxied tool refresh crash** — `registerProxiedTools()` used `registerTool` (throws on duplicate names). When `probeAll()` called it on an existing session after a child bridge plugin hot-reload, it threw for every already-registered tool, silently breaking the session. Switched to `replaceTool` (upsert).

---

## [2.5.13] — 2026-03-25

### Fixed
- **SSE parser** — `ChildBridgeClient.post()` now returns the last `data:` frame that contains a `result` or `error` field. Previously the first `data:` line was used, so progress notifications emitted before the final result were silently returned as the tool output for long-running tools.
- **404 session-expiry recovery** — When a child bridge's HTTP session expires (2-hour idle TTL), `callTool()` now nulls the session ID, re-initialises, and retries once instead of counting the 404 toward the circuit breaker. Avoids false "bridge unavailable" errors on healthy bridges.
- **`pickBest()` tie-break** — Now sorts by `consecutiveFailures` ascending before `startedAt` descending, matching `pickForWorkspace()` behaviour.
- **`__toolName` argument injection removed** — Proxied tools in the orchestrator now dispatch via named closures only. The previous dynamic dispatch path injected `__toolName` into tool arguments, which would silently drop any child bridge tool argument with that name.
- **Proxied tools refresh on health probe** — `probeAll()` now always re-fetches the tool list from each child bridge. When the list changes (e.g. after a plugin hot-reload), existing sessions receive updated tool registrations and a `notifications/tools/list_changed` notification.
- **Orchestrator reconnect** — `transport.markInitialized()` is called after `transport.attach()` so Claude Code sessions that reconnect without re-sending the MCP `initialize` handshake can call tools immediately.

---

## [2.5.8] — 2026-03-23

### Added
- **`source: 'settings'` plugin support documented** — `claude-ide-bridge-plugin/README.md` now includes Option 3 (project-level team sharing via `enabledPlugins` in `.claude/settings.json`). No CLI flags needed; Claude Code loads the plugin automatically from the project root.

### Security
- **WebSocket Host header allowlist extended** — `ALLOWED_HOSTS` was hardcoded to loopback addresses. Remote deployments using `--cors-origin` (e.g. `https://bridge.example.com`) now have their hostname added to the WS upgrade allowlist, fixing a correctness issue where reverse-proxy deployments rejected legitimate WebSocket connections. (MEDIUM, finding #5)

### Fixed
- **Onboarding docs overhaul** — plugin README Quick Start added (env var, extension install, `--watch`, verify step); SETUP.md Remote Control sections removed (stale); `install-extension` positional arg syntax corrected; CHANGELOG gaps for v2.5.3/2.5.5/2.5.6/2.5.7 filled.
- **`session-info.sh`** — "no bridge detected" message now correctly says `claude-ide-bridge --watch` instead of `npm start`.
- **`templates/CLAUDE.bridge.md`** — replaced `getToolCapabilities` at session start with `getBridgeStatus`; fixed scheduled-task copy path for npm global installs.
- **Plugin examples** — `02-review-pull-request.md`: fixed `githubCreateReview` → `githubPostPRReview`; `03-refactor-with-lsp.md`: use `renameSymbol` instead of `searchAndReplace` for LSP-aware renames.
- **`deploy/README.md`** — clarified that `install-vps-service.sh` handles service restart automatically.

---

## [2.5.7] — 2026-03-23

### Changed
- **Agent frontmatter tightened** — all 3 built-in subagents (`ide-code-reviewer`, `ide-debugger`, `ide-test-runner`) now declare explicit `maxTurns` limits (30/20/15 respectively) and `disallowedTools` lists. `ide-code-reviewer` also blocks `Edit` and `Write` to enforce read-only review behaviour. `deleteFile` is blocked across all three.

---

## [2.5.6] — 2026-03-23

### Added
- **Regression test suite expanded**: bridge now has 1349 tests (+8 covering `runCommand` `-f`/`-r` per-command blocking and curl output flags); extension has 406 tests (+12: new `httpProbe.test.ts` file, 4 multi-bridge lockfile tests).

### Changed
- **Docs updated** — `platform-docs.md` and `styleguide.md` refreshed to reflect `runInTerminal` timeout behaviour, `runCommand` dangerous-flag table, OAuth register endpoint, and security patterns introduced in v2.5.x.

---

## [2.5.5] — 2026-03-23

_Internal npm slot. No additional changes beyond v2.5.4 — published to resolve a registry slot conflict with v2.5.3._

---

## [2.5.4] — 2026-03-23

### Added
- **ElicitationResult hook** (`claude-ide-bridge-plugin`) — fires when a user cancels or times out an MCP elicitation dialog; silent on submit (expected normal flow).
- **`effort` frontmatter** on all built-in skills: `low` for data-gathering/rendering skills (ide-coverage, ide-diagnostics-board, ide-deps), `high` for deep analysis/action skills (ide-review, ide-explore, ide-refactor, ide-debug, ide-quality).
- **Rate limit awareness** in `session-info.sh` — surfaces 5-hour and 7-day quota percentages at session start when above 50%/80% respectively (uses `rate_limits` field added in Claude Code 2.1.80).

### Changed
- **`SubprocessDriver` now passes `--bare`** when spawning Claude Code subprocesses via `runClaudeTask`. Prevents hook loops when the subprocess shares `~/.claude/` with the parent session.
- **`-f` and `-r` flags unblocked globally** from `DANGEROUS_PATH_FLAGS`. These common short flags (`grep -r`, `docker -f`, `sort -f`, etc.) were incorrectly blocked for all commands. They are now blocked only for the specific commands where they are dangerous: `make -f` (arbitrary Makefile path) and `node`/`ts-node`/`tsx -r` (arbitrary module pre-require). Uses new `DANGEROUS_FLAGS_FOR_COMMAND` per-command table.

### Fixed
- 19 regression tests added for v2.5.2 security/bug fixes (1341 total, 0 failures).

---

## [2.5.2] — 2026-03-23

### Security
- **CRITICAL — OAuth open redirect**: `handleRegister` now stores `redirect_uris` in a `registeredClients` map. Both `GET /oauth/authorize` (via `parseAuthorizeParams`) and `POST /oauth/authorize` (approve and deny paths) validate the presented `redirect_uri` against the registered set before issuing any redirect. An unregistered URI returns 400 instead of following the attacker-controlled location.
- **HIGH — `handleRegister` URI validation**: Each `redirect_uri` is validated as an absolute URL with `https:` scheme or `localhost`/`127.0.0.1` host. Non-HTTPS non-localhost URIs are rejected with 400.
- **HIGH — curl output flags blocked**: `-o`, `--output`, `-O`, `--remote-name`, `-D`, `--dump-header`, `-K` added to `DANGEROUS_PATH_FLAGS` in `runCommand`. These flags allow writing files to arbitrary paths on VPS deployments.
- **MEDIUM — scope validation on registration**: `handleRegister` now rejects any requested scope not in `SUPPORTED_SCOPES` (currently `["mcp"]`) with 400 `invalid_client_metadata`.

### Fixed
- **HIGH — `runInTerminal` double-execution**: When the extension times out waiting for shell integration output, the tool now returns a clear error instead of falling through to the subprocess fallback. The command was already dispatched to the VS Code terminal; re-executing it via subprocess could double-invoke non-idempotent operations.
- **MEDIUM — `applyEditsToContent` invalid range**: Edits where `endLine < line` or (`endLine === line` and `endColumn < column`) now throw a descriptive error instead of silently producing a no-op splice.
- **MEDIUM — `isValidRef` too restrictive**: Refs like `HEAD~3`, `HEAD^`, `HEAD^2`, and `stash@{0}` are now valid. The character class was expanded from `[\w.\-/]` to `[\w.\-/^~@{}]`. Leading-dash and `..` range syntax are still rejected.
- **MEDIUM — vitestJest silent failure**: Both vitest and jest runners now throw when `execSafe` returns exit code 127 (command not found) or null (killed by signal), instead of returning an empty results array indistinguishable from "0 tests passed".
- **LOW — automation cooldown on failed enqueue**: `lastTrigger.set` is now called only after `orchestrator.enqueue()` succeeds. A failed enqueue no longer imposes a spurious cooldown on the next trigger attempt.
- **Clarified `O_NOFOLLOW ?? 0` in `lockfile.ts`**: Added detailed comment explaining why `O_EXCL` alone is sufficient on Windows (where `O_NOFOLLOW` is undefined). No behavior change.

---

## [2.5.3] — 2026-03-23

_Contains the same security and bug fixes as v2.5.2. Published separately due to a registry slot conflict (v2.5.2 was retracted after a brief publish window)._

---

## [2.4.0] — 2026-03-18

### Added
- **OAuth 2.0 Authorization Server** (`src/oauth.ts`) — full RFC 6749 authorization code grant with PKCE (S256), RFC 8414 discovery metadata, and RFC 7009 token revocation. Enables authenticated remote MCP server registration on claude.ai.
  - `GET /.well-known/oauth-authorization-server` — RFC 8414 discovery document
  - `GET /oauth/authorize` — approval page (requires bridge token to initiate)
  - `POST /oauth/authorize` — form submission; issues single-use auth codes (5 min TTL)
  - `POST /oauth/token` — exchanges code + PKCE verifier for access token (1 h TTL)
  - `POST /oauth/revoke` — RFC 7009 token revocation
  - Backward-compatible: existing static bearer tokens continue to work
- `--issuer-url <url>` CLI flag and `CLAUDE_IDE_BRIDGE_ISSUER_URL` env var to set the OAuth issuer URL
- `docs/privacy-policy.md` — privacy policy for the plugin marketplace submission
- `docs/ip-allowlist.md` — network access and IP allowlist documentation for self-hosters
- `claude-ide-bridge-plugin/examples/` — three working example walkthroughs for the plugin directory listing:
  - `01-debug-failing-test.md`
  - `02-review-pull-request.md`
  - `03-refactor-with-lsp.md`

### Changed
- Safety annotations: `setHandoffNote` now declares `destructiveHint: true, idempotentHint: true`; `getHandoffNote` declares `readOnlyHint: true`

### Tests
- 23 new tests for `OAuthServerImpl` covering discovery, authorize GET/POST, token issuance, PKCE verification, code reuse rejection, revocation, and `resolveBearerToken`

---

## [2.3.0] — 2026-03-01

### Fixed (SSH remote issues)
- `runInTerminal` subprocess fallback for SSH remotes
- LSP cold-start retry with 0→4→8s exponential backoff
- Probe detects `tsc`, `biome`, `rg` via `node_modules/.bin`
- `searchAndReplace` glob normalisation (`*.ts` → `**/*.ts`)
- `closeTab` `realpathSync` fix
- `captureScreenshot` headless error message

### Added
- `@vscode/ripgrep` dependency with postinstall symlink
- `smoke-test-v2.mjs` regression gate (26 PASS / 0 FAIL baseline)
- Extension v1.0.9

### Tests
- 1237 unit tests across 101 test files
