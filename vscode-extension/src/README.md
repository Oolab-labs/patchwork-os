# vscode-extension/src

This is the companion editor extension (VS Code / Windsurf / Cursor) that connects to the bridge over a WebSocket and does the things the headless bridge process cannot: LSP-backed navigation and refactors, debugger control, terminal execution, file watching, and inline editor decorations. It discovers the running bridge via lock files, maintains the connection through sleep/reconnect cycles, and dispatches inbound bridge requests to one handler per tool category. Everything here is a thin proxy layer — the actual tool logic and MCP registration live in the bridge (`src/`), this just exposes editor-native primitives over the wire.

## The 5 files that matter and why

- **`connection.ts`** — owns the entire WebSocket lifecycle: lock-file discovery, reconnect backoff, heartbeat/RTT-ping, generation counters. Read CLAUDE.md's "Transport & Session Model" section before touching this file.
- **`extension.ts`** — activation entrypoint; wires `BridgeConnection` to VS Code events (editor changes, diagnostics, git state) and registers the request-handler map.
- **`lockfiles.ts`** — bridge discovery: reads `~/.claude/ide/*.lock`, filters to `isBridge: true` entries (skips IDE-owned locks), sorts newest-first. This is how the extension finds a bridge to connect to at all.
- **`handlers/lsp.ts`** — representative handler file; the largest and busiest, proxying goToDefinition/findReferences/hover/etc. to VS Code's language-server APIs. Good template for how a new handler should be shaped.
- **`handlers/debug.ts`** — the debugger bridge (breakpoints, evaluate, session state); shows the customRequest-with-timeout pattern (`withTimeout`) other handlers reuse for anything that can hang against a stalled debug adapter.

## Invariants you must not break

- **New handler methods must use `tryRequest` / `validatedRequest` / `requestOrNull`, never a blind `proxy<T>()` cast.** This is a hard-won convention — eight latent shape-mismatch bugs shipped between v2.25.18 and v2.25.24 from `proxy<T>()`. See CLAUDE.md's "Architecture Rules" section (`extensionClient` shape validation) for which helper fits which handler contract before writing new code.
- **Every WebSocket callback must check the generation guard** (`gen !== this.generation`) before acting, or a stale callback from a prior connection can corrupt new connection state. See ADR-0002 (`docs/adr/0002-generation-guards-on-reconnect.md`).
- **The RTT-pong handler must update `lastBridgePong`.** This was a real production bug (P0-3, fixed 2026-06-25): the bridge never pinged the extension's WebSocket because only the separate sleep-probe pong handler refreshed `lastBridgePong`, causing false-positive reconnect churn. See `docs/security/register.md` and `connection.ts` around the RTT pong handler for the fix; don't regress it.

## How to test it

Run `npm test` from `vscode-extension/` (vitest). Tests live in `src/__tests__/` (one file per module, e.g. `connection-edge-cases.test.ts`, `connection-fixes.test.ts`, `lockfiles-multiworkspace.test.ts`) and `src/__tests__/handlers/` (one per handler). New handlers need tests in the latter directory per CLAUDE.md's "Testing Requirements".

Before packaging a `.vsix` for manual install (Windsurf, Cursor, etc.), **bump the version in `vscode-extension/package.json` first** — Windsurf caches `.vsix` files by version number and silently reuses the old bundle otherwise. See CLAUDE.md's "Extension versioning rule" for detail. Build with `npm run build` (esbuild), then `npm run package` (`vsce package --no-dependencies`).
