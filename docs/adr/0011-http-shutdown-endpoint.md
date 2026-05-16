# ADR-0011: HTTP `/shutdown` Endpoint for Clean Exit on Windows

**Status:** Accepted
**Date:** 2026-05-16

## Context

`process.kill(pid, "SIGTERM")` on Windows is implemented as `TerminateProcess`. Registered SIGTERM handlers never fire — the process is terminated by the kernel without running any user code. That means the bridge's cleanup sequence (lockfile unlink, HTTP server close, telemetry flush, automation-state checkpoint) doesn't run, and the next bridge start either trips the stale-lock check or has to rebuild state that should have been persisted.

The smoke harness exposes this directly. CAT-11.5 and CAT-11.6 assert clean-shutdown invariants — lockfile absent after exit, no orphan tmp dirs. Both were previously `describe.skipIf(process.platform === "win32")` because there was no way to drive a SIGTERM-equivalent on Windows that ran the cleanup path.

`/restart` had the same defect. The original implementation shelled out to `process.kill(self, "SIGTERM")` and relied on the bridge's SIGTERM handler to restart. On Windows it killed the bridge without cleanup and the supervisor restarted it on top of a stale lock.

## Decision

Bearer-authenticated `POST /shutdown` endpoint ([src/server.ts:2044](../../src/server.ts)). The bridge wires `server.shutdownFn` (and the previously-broken `server.restartKillFn`) to call the shutdown closure DIRECTLY rather than going through signal delivery:

```ts
// src/bridge.ts:1794
this.server.restartKillFn = () => { void shutdown("SIGTERM", 143); };
this.server.shutdownFn   = () => { void shutdown("SIGTERM", 0);   };
```

The HTTP handler reuses the same in-flight safety check as `/restart` ([src/server.ts:2046](../../src/server.ts) — `restartCheckFn` returns `inFlightCalls` and `busySessions`). `?force=1` overrides. A 409 with `error: "shutdown_blocked"` and the in-flight count is returned when work is in progress and force is not set.

Path identical on POSIX and Windows. Signal delivery is no longer in the critical path on Windows — and on POSIX it's still available via the global `SIGTERM` handler for `kill(1)` and Ctrl-C scenarios.

## Alternatives considered

1. **`CTRL_BREAK_EVENT` via Win32 `GenerateConsoleCtrlEvent`.** Requires the child to have been spawned with `windows_verbatim_arguments: true` and its own console, which the bridge isn't in production launch paths (services, npm scripts, supervisor-managed). Brittle and platform-coupled.
2. **`process.emit("SIGTERM")` synthetic event.** Works only if a JS handler is registered on the same tick the emit happens. Race-prone against the order-of-initialization in `bridge.ts`, and silently no-ops if the handler hasn't been wired yet.
3. **Keep skipping CAT-11.5/11.6 on win32.** Loses real cleanup coverage on the platform that needs it most — Windows is where the cleanup-path bugs actually live.
4. **POST `/restart` with a "no-restart" body flag.** Overloads `/restart` semantics; the in-flight-check and the dispatch logic diverge enough that a separate endpoint is clearer.

## Consequences

- Smoke harness branches on `process.platform === "win32"` in [scripts/smoke/cat11-shutdown.mjs](../../scripts/smoke/cat11-shutdown.mjs): POSIX path drives SIGTERM, win32 path POSTs `/shutdown`. Both paths exercise the same cleanup sequence inside the bridge.
- `/restart` semantics fixed as a side effect — on Windows it now runs the cleanup sequence before the supervisor restarts.
- New consumer requirement: clients with a Bearer token can now shut the bridge down. This is NOT new attack surface — any holder of the Bearer token can already call every other authenticated tool, and the bridge is loopback-bound by default.
- The 100ms `setTimeout` before invoking `shutdownFn()` ([src/server.ts:2076](../../src/server.ts)) is load-bearing: it lets the HTTP response flush before the socket dies, so the smoke harness sees the 202 instead of ECONNRESET.
- Originating PR: #534.
