# ADR-0010: Windows Port Helpers

**Status:** Accepted
**Date:** 2026-05-16

## Context

The bridge ran on macOS and Linux for the first ~18 months of its life. When we audited it for Windows, three patterns recurred at nearly every spawn/watch site and each one needed a per-call workaround:

1. **`.cmd` shims.** npm-installed binaries on Windows are `.cmd` files in `node_modules/.bin/` and `%APPDATA%\npm`. Node's `child_process.spawn` with `shell:false` only auto-resolves `.exe` via `PATHEXT` — calling `spawn("claude", …)` ENOENTs on Windows even though `claude --version` works in any terminal. Wrapping every site in `shell: process.platform === "win32"` works but hides the intent, opens an argument-quoting hazard, and was applied inconsistently.
2. **Process trees.** Windows has no process-group concept. `child.kill()` (and the AbortSignal-driven kill that `spawn({ signal })` wires up) signals only the immediate child, leaving grandchildren orphaned when a Claude subprocess task is cancelled or times out.
3. **`fs.watch` reliability.** `fs.watch` throws or silently stops firing on Windows SMB/CIFS shares, WSL bind mounts, and macOS volumes mounted from a Linux host. The plugin hot-reload watcher and the kill-switch flag watcher both went dead on those mounts with no error.

Each pattern was hit by 4–8 call sites. Inlining the workaround at every site was the original instinct and rapidly produced drift.

## Decision

Three small helpers, each one a shared seam, shipped together so that future cross-platform code has one obvious place to go:

- **[src/winShim.ts](../../src/winShim.ts)** — `ensureCmdShim(binary: string): string`. Appends `.cmd` to bare binary names on win32. No-op on POSIX. No-op if the name already has an extension or contains a path separator. Uses `path.win32.extname` explicitly so tests that mock `process.platform` on a POSIX host behave identically.
- **[src/processTree.ts](../../src/processTree.ts)** — `treeKill(child: ChildProcess, signal?: NodeJS.Signals): void`. On Windows shells out to `taskkill /F /T /PID <pid>`; on POSIX calls `process.kill(-pid, signal)` against the process group (requires the child to have been spawned `detached: true`). Always invokes `child.kill(signal)` as a single-child backstop. Best-effort: an already-exited child is not an error.
- **[src/fsWatchWithFallback.ts](../../src/fsWatchWithFallback.ts)** — `watchDirectoryWithFallback(dir, onChange, opts?): () => void`. Tries `fs.watch(dir, { recursive: false })` first, listens for its `error` event, and on either failure mode swaps to 2-second `mtime` polling. Polling fallback also handles "directory doesn't exist yet" by polling until it appears. Deliberately does not surface the changed filename — callers re-read the file(s) they care about, which keeps them platform-agnostic.

## Alternatives considered

1. **`shell:true` at every spawn site.** Works, but hides intent, exposes argument-quoting bugs (any argument containing spaces or `&` needs platform-specific escaping), and was applied inconsistently in the first sweep — half the sites had it, half didn't.
2. **`cross-spawn` package.** Adds a dependency for what is effectively a 10-line function, and doesn't help with the process-tree or fs.watch problems. Solving one of three issues with a dep is a bad trade.
3. **Env-detection in a spawn wrapper that mutates `opts` in place.** Loses the type-safety of the native `spawn` signature — callers stop seeing the actual `SpawnOptions` shape and start passing whatever the wrapper documents. Made tool authoring worse for a small reduction in call-site churn.
4. **For `fs.watch`: chokidar.** Heavy dependency (it pulls in `fsevents` on macOS, `readdirp`, etc.) when the bridge's needs are minimal — flat directories, ~10 files, change-coalescing handled by the caller.

## Consequences

- Every cross-platform spawn site that names a binary by stem MUST go through `ensureCmdShim` OR set `shell: process.platform === "win32"`. The grep for new violations is `spawn\(("|')[a-z]` across `src/`.
- `treeKill` is mandatory for any subprocess that itself spawns children (Claude orchestrator tasks, recipe runners). A bare `child.kill()` on those leaves orphan processes on Windows under cancellation/timeout.
- `fs.watch` consumers in production paths (kill-switch flag watcher in [src/featureFlags.ts](../../src/featureFlags.ts), plugin hot-reload) should use `watchDirectoryWithFallback`. Tests and ephemeral tooling can keep using raw `fs.watch`.
- When writing an MCP stdio config that another process will spawn (e.g. `claude -p --mcp-config`), `ensureCmdShim` must be applied at config-write time — the consuming process inherits the same `shell:false` limitation.
- Originating PRs: #525 (initial `.cmd` shim fix for the Claude subprocess driver), #527 (sweep of remaining spawn sites onto `ensureCmdShim`), #528 (`treeKill`), #531 (`fsWatchWithFallback`).
