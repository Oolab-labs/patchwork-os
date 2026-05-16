# Windows Support Guide

Patchwork OS — bridge, VS Code extension, smoke harness, and CI — runs natively on Windows without WSL. This guide covers the Windows-specific architecture decisions, the things that work differently from POSIX, and the patterns to follow when contributing Windows-touching code.

For setup (install / start), see the [Windows Quick Start in the README](../README.md#-windows-quick-start). This document is for "I want to understand how it works" and "I'm fixing a Windows bug."

---

## What works

- Bridge process (`patchwork start`, `claude-ide-bridge`)
- VS Code / Cursor / Windsurf / Antigravity extensions
- Smoke harness (`scripts/smoke/run-all.mjs` via `bridge.cmd`)
- Cross-platform orchestrator (`npm run start-all:node`)
- PowerShell-native orchestrator (`npm run start-all:win`)
- Dashboard, recipes, automation hooks, kill-switch, plugins
- 177 MCP tools — same set as POSIX

## What requires WSL2 or Git Bash

- `patchwork start` / `npm run start-all` — uses bash + tmux directly
- `npm run remote` / `npm run vps` — bash-based VPS provisioning scripts

For a fully bash-free path, use `npm run start:bridge` + `npm run start-all:node` (or `start-all:win`). See [README §Windows Quick Start](../README.md#-windows-quick-start) for full command reference.

---

## Architecture

Three small helper modules absorb the platform differences so callers stay platform-agnostic. See [ADR-0010](adr/0010-windows-port-helpers.md) for the design rationale.

### `src/winShim.ts` — `.cmd` shim resolution

```ts
import { ensureCmdShim } from "./winShim.js";
spawn(ensureCmdShim("claude"), args, { ... });   // → "claude.cmd" on win32, "claude" elsewhere
```

npm global bins on Windows are `.cmd` files in `%APPDATA%\npm`. Node's `child_process.spawn` with `shell:false` only auto-resolves `.exe` via `PATHEXT`. Calling `spawn("claude", …)` ENOENTs on Windows even though `claude --version` works in any terminal.

`ensureCmdShim` is the canonical fix when you have the binary name as a string. The alternative — `shell: process.platform === "win32"` — works but exposes argument-quoting hazards (any arg with spaces / `&` / `|` needs platform-specific escaping). Prefer `ensureCmdShim` when the caller knows it's invoking an npm bin.

### `src/processTree.ts` — `treeKill`

```ts
import { treeKill } from "./processTree.js";
const child = spawn(cmd, args, { detached: true, ... });
// ...later, on cancel/timeout:
treeKill(child, "SIGTERM");
```

Windows has no process-group concept. `child.kill()` (and the AbortSignal-driven kill that `spawn({ signal })` wires up) signals only the immediate child, leaving grandchildren orphaned when a Claude orchestrator task is cancelled or times out.

`treeKill` shells out to `taskkill /F /T /PID <pid>` on Windows + `child.kill(signal)` as a single-child backstop. On POSIX it does `process.kill(-pid, signal)` against the process group (requires the child to have been spawned `detached: true`) + the same backstop. Always best-effort: already-exited children are not an error.

### `src/fsWatchWithFallback.ts` — `watchDirectoryWithFallback`

```ts
import { watchDirectoryWithFallback } from "./fsWatchWithFallback.js";
const stop = watchDirectoryWithFallback(dir, () => reloadConfig());
// ...later:
stop();
```

`fs.watch` throws or silently stops firing on Windows SMB/CIFS shares, WSL bind mounts, and macOS volumes mounted from a Linux host. The plugin hot-reload watcher and kill-switch flag watcher both went dead on those mounts with no error.

The helper tries `fs.watch` first, listens for its `error` event, and on either failure swaps to 2-second `mtime` polling. Also handles "directory doesn't exist yet" by polling until it appears.

---

## Clean shutdown

`process.kill(pid, 'SIGTERM')` on Windows is `TerminateProcess` — registered SIGTERM handlers never fire. The bridge cleanup path (lockfile unlink, HTTP server close, telemetry flush) doesn't run.

Solution: `POST /shutdown` HTTP endpoint (Bearer-authenticated). Bridge wires `server.shutdownFn` to call the shutdown closure directly rather than going through signal delivery. The smoke harness uses `/shutdown` on win32 and SIGTERM on POSIX. See [ADR-0011](adr/0011-http-shutdown-endpoint.md).

---

## CI

`windows-latest` is a blocking gate on both the smoke + extension jobs in `.github/workflows/ci.yml`. Was advisory through PRs #527-#536 while the harness was being ported; flipped to blocking in #537. See [ADR-0012](adr/0012-windows-ci-blocking.md).

**Known timing quirk:** GitHub Actions Windows runners have noticeably slower cold-start than ubuntu runners — `cmd.exe` shim wrapping adds ~3-5s per spawn. `scripts/smoke/helpers.mjs` applies a 2× `WIN_TIMEOUT_MULTIPLIER` to `waitForBridge` to absorb this without per-test bumps. If you see new flaky timeouts only on Windows, the first thing to check is whether the test should be using `waitForBridge` instead of a fixed `await sleep(N)`.

---

## Common patterns when contributing

When fixing or extending Windows-relevant code, check these first:

| Symptom | First thing to check |
|---|---|
| `spawn` ENOENTs on a named binary | Missing `ensureCmdShim` or `shell: process.platform === "win32"` |
| Subprocess cancellation leaves orphan processes | Replace `child.kill()` with `treeKill(child)` |
| File watcher silently stops firing | Switch to `watchDirectoryWithFallback` |
| Path glob doesn't match | Backslash separators — `src/fp/automationInterpreter.ts:matchesCondition` normalises and sets `nocase: true` on win32; mirror that pattern |
| Allowlist permits `cmd.exe` / `node.exe` | `src/config.ts:isInterpreterCommand()` strips `.exe`/`.cmd`/`.bat`/`.com`/`.ps1` before set lookup |
| `.cmd` batch file misbehaves on first run | Check line endings — `*.cmd / *.bat / *.ps1` need CRLF; `.gitattributes` enforces `text eol=crlf` |
| Cleanup handlers don't run on bridge exit | SIGTERM is TerminateProcess on Windows; use `POST /shutdown` |

Originating PRs for the audit campaign: #525, #527, #528, #529, #530, #531, #532, #534, #535, #536, #537, #538. ADRs 0010-0012.

---

## Trust model on Windows

Lock file (`%USERPROFILE%\.claude\ide\<port>.lock`) carries the Bearer auth token. On Windows the NTFS ACL is owner-only by default for files under `%USERPROFILE%`, equivalent in practice to POSIX `0o600`. No explicit `chmod` call is made — `fs.chmod` is a no-op on Windows.

Same-user trust is the project-wide assumption (see [ADR-0003](adr/0003-isbridge-lock-file-flag.md)) on every platform; Windows doesn't change that. If you're deploying on a shared Windows host, the recommended pattern is the same as POSIX: don't, use a VPS instead.

---

## Troubleshooting

**`'claude-ide-bridge' is not recognized as an internal or external command`** — Reinstall via `npm install -g patchwork-os` and restart your shell so PATHEXT picks up the new `.cmd` shim.

**`Bridge lock file for port NNNNN not found after Nms`** in CI but not locally — `waitForBridge` timeout is too tight for the Windows runner. The harness applies a 2× multiplier on win32; if you're calling lower-level fs operations directly, use the same shape.

**Smoke `bridge.cmd` fails with `'m' is not recognized as an internal or external command`** — `bridge.cmd` got LF line endings instead of CRLF (likely via a copy through a POSIX tool that didn't honor `.gitattributes`). Re-clone or run `git add --renormalize .` to restore.

**Dashboard doesn't open in browser** — `start http://localhost:3200` from `start-all:node` uses `cmd /c start` on Windows. If that returns immediately without opening a browser, your default browser association may be broken — open the URL manually.

**Plugin hot-reload not firing** — confirm the plugin directory isn't on a network share or WSL mount. If it is, the watcher should auto-fall back to 2s polling; if it doesn't, file a bug with the plugin path.
