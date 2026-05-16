# ADR-0013: Write-Tier Kill-Switch Design

**Status:** Accepted
**Date:** 2026-05-16

## Context

The bridge has a global write-tier kill-switch — when engaged, every recipe tool that mutates external state (post to Slack, send email, push to git, write a file, etc.) raises before dispatch. The engine was already in place before this ADR:

- Flag definition: `KILL_SWITCH_WRITES = "kill-switch.writes"` in [src/featureFlags.ts:288](../../src/featureFlags.ts).
- Read helper: `isWriteKillSwitchActive()` at [src/featureFlags.ts:392](../../src/featureFlags.ts).
- Enforcement: `assertWriteAllowed(toolId)` called at [src/recipes/toolRegistry.ts:119](../../src/recipes/toolRegistry.ts), gated at the recipe-dispatch boundary so every recipe-driven write goes through one chokepoint.
- Env lock: `PATCHWORK_FLAG_KILL_SWITCH_WRITES=<bool>` set at startup is frozen by `lockKillSwitchEnv()` and cannot be overridden at runtime — see env-lock map at [src/featureFlags.ts:66](../../src/featureFlags.ts) (`FROZEN_KILL_SWITCH_ENV`) and the throw path in `setFlag` at [src/featureFlags.ts:217](../../src/featureFlags.ts).

What was missing was user-facing surface area: a dashboard toggle, a CLI, and a propagation model. A naive implementation reviewed as a "product-grade safety hazard" — a kill-switch toggle that only flips the local bridge's state, while three other live bridges (mobile, desktop, VPS) keep writing, is worse than no kill-switch at all because it creates false confidence. Issue #422 hosts the full 4-agent design review; this ADR captures the landed decisions.

## Decision

Four-part shape:

1. **Dedicated `POST /kill-switch` HTTP endpoint** ([src/server.ts:1793](../../src/server.ts)), NOT shoehorned into the existing `/settings` god-handler. Body `{engage, reason?}`. Structured `409 {error: "env_locked", flag, lockedValue, lockedReason}` when the flag is env-locked at startup. Audit trace emitted on every state transition via the existing decision-trace store — tagged `["kill-switch", "engage" | "release", "actor:http"]` so `ctxQueryTraces({tag: "kill-switch"})` returns the full audit history without a schema migration. See the trace-encoding comment at [src/server.ts:337](../../src/server.ts).

2. **CLI fan-out across ALL live bridges.** `patchwork kill-switch engage|release|status` ([src/index.ts:1910](../../src/index.ts)) discovers every live bridge via `findAllLiveBridges()` in [src/bridgeLockDiscovery.ts:64](../../src/bridgeLockDiscovery.ts) and POSTs `/kill-switch` to each. Single-bridge would leave siblings (a mobile bridge, a VPS bridge, an extension-side bridge) writing through. `patchwork panic` ([src/index.ts:2123](../../src/index.ts)) is a stress-discovery alias for `kill-switch engage`.

3. **`fs.watch` on the flags directory** so out-of-band writes converge across all running bridges within ~100ms. Wired at [src/featureFlags.ts:366](../../src/featureFlags.ts) via [`watchDirectoryWithFallback`](../../src/fsWatchWithFallback.ts) (see [ADR-0010](0010-windows-port-helpers.md)). This catches the `--force-local` CLI fallback path AND manual sysadmin edits to `flags.json`. Polling fallback covers Windows network drives and WSL bind mounts.

4. **SSE `kind: "kill-switch"` event from `/stream`** so the dashboard updates in <1s without changing its poll cadence. Broadcast on every transition out of the `/kill-switch` handler ([src/server.ts:1906](../../src/server.ts)). Dashboard toggle UI: [dashboard/src/app/settings/page.tsx](../../dashboard/src/app/settings/page.tsx).

## Alternatives considered

1. **Single-bridge CLI.** Rejected — multi-bridge false-safety gap. A user on a laptop who's also running a VPS bridge would engage the kill-switch on the laptop, see the dashboard go red, and walk away while the VPS bridge kept posting.
2. **Fold into `/settings`.** Rejected — `/settings` is a god-handler with a heterogeneous body shape and a generic 400 path. The kill-switch needs structured failure codes (`env_locked`) and the env-lock 409 needs to be unambiguous in HTTP logs and in audit traces.
3. **`process.kill(pid, "SIGUSR1")` to signal a flag-reload.** POSIX-only; Windows has no equivalent (see [ADR-0011](0011-http-shutdown-endpoint.md) for the same problem on shutdown). Cross-platform flag-watch via the filesystem works everywhere.
4. **In-process `EventEmitter`.** Works for one process, but the whole problem is multi-bridge convergence. Doesn't help.
5. **Poll the flag file at toolRegistry dispatch time.** Adds latency to the hot path and doesn't help the dashboard surface state. `fs.watch` + polling fallback is the right shape — push, not pull.
6. **`setFlag()` returns `Result<void, EnvLockedError>` discriminated union.** Considered but rejected. Every caller would have to pattern-match. A single throwable error class (`EnvLockedFlagError` at [src/featureFlags.ts:182](../../src/featureFlags.ts)) is caught once in the `/kill-switch` handler and ignored elsewhere — `setFlag` is rarely called from non-kill-switch paths and never needs to recover from env-lock at those sites.

## Consequences

- **Mandatory 10s `AbortController` deadline per HTTP call** in the CLI fan-out ([src/index.ts:1988](../../src/index.ts) and matching sites at 2218, 2377). A wedged bridge that accepts the connection but never responds must not give the operator the impression that "engage succeeded everywhere" — a timeout is reported as a per-bridge failure with a non-zero exit code.
- **CLI fallback writes to a sibling `decision_traces.cli.jsonl`** ([src/index.ts:1962](../../src/index.ts)) instead of the bridge-owned `decision_traces.jsonl`. Avoids mixed-writer atomicity issues — [ADR-0007](0007-multi-bridge-jsonl-concurrency.md) covers the single-writer invariant; the CLI is not the writer.
- **`setFlag()` throws `EnvLockedFlagError`** rather than returning a discriminated union. Single error type to catch in the endpoint handler. Tests on non-kill-switch flag paths see no throw — env-lock only freezes kill-switch flags by design ([src/featureFlags.ts:75](../../src/featureFlags.ts)).
- **`patchwork panic` discoverable from `--help`** — listed in the CLI's command table at [src/index.ts:181](../../src/index.ts). Stress-discovery matters: an operator in an incident shouldn't have to remember "kill-switch engage" syntax.
- The full design dialogue lives in issue #422; this ADR is the durable subset of the landed decisions.
