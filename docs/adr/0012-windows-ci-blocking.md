# ADR-0012: `windows-latest` CI Graduation from Advisory to Blocking

**Status:** Accepted
**Date:** 2026-05-16

## Context

Windows CI was added in PR #532 with `continue-on-error: ${{ matrix.os == 'windows-latest' }}` on both the smoke and extension jobs in [.github/workflows/ci.yml](../../.github/workflows/ci.yml). That made `windows-latest` advisory: failures showed up in the matrix UI but did not block merge.

Advisory was the correct starting posture. The smoke harness had never run on Windows and was full of POSIX-isms (path separators, signal delivery, shell quoting). The extension test fixtures hardcoded POSIX paths in many places and many of the actual integration suites were `describe.skipIf(process.platform === "win32")`. Flipping to blocking immediately would have wedged every PR.

Five PRs (#533–#537) drove the matrix green:

- #533 — smoke-harness POSIX-isms (path normalisation, env shape)
- #534 — CAT-11.5/11.6 enabled on win32 via `/shutdown` (see [ADR-0011](0011-http-shutdown-endpoint.md))
- #535 — un-skipped the previously-`describe.skipIf(win32)` extension suites
- #536 — extension fixture path normalisation
- #537 — flip the gate

## Decision

Drop `continue-on-error` on both the smoke and extension matrix entries (#537). `windows-latest` is now a blocking required check. Comments in [.github/workflows/ci.yml](../../.github/workflows/ci.yml) at lines 175 and 288 document the advisory window (PRs #527–#536) so the history is reachable from the file.

## Followup observed

The first post-flip run failed CAT-4 — parallel-spawn cold-start exceeded the harness's 10-second `waitForBridge` budget. The bridge actually started fine; cmd.exe shim wrapping (see [ADR-0010](0010-windows-port-helpers.md)) plus GitHub-runner disk I/O variance added enough latency to blow past 10s under parallel load specifically.

Resolved in #538 by adding a platform-conditional multiplier to [scripts/smoke/helpers.mjs](../../scripts/smoke/helpers.mjs):

```js
// helpers.mjs:120
const WIN_TIMEOUT_MULTIPLIER = process.platform === "win32" ? 2 : 1;
```

`waitForBridge(port, timeoutMs)` then uses `timeoutMs * WIN_TIMEOUT_MULTIPLIER` (line 129). The flip itself was correct; the 10s budget was just too tight for win32 cold-start under `.cmd` wrapping.

## Alternatives considered

1. **Keep advisory permanently.** Defeats the gate. Regressions silently accumulate; the matrix UI becomes background noise that nobody checks.
2. **Require N consecutive green runs before flipping (conservative gate).** More cautious but slower. With the cost of a revert PR low, we chose the lighter "5 PRs of green" heuristic (#533–#536 green, then #537 flipped).
3. **Per-job rather than per-matrix `continue-on-error` flip.** Considered for smoke-only first, but the extension suite was green at the same time, so flipping both together kept the gate consistent.

## Consequences

- Every PR now sees `windows-latest` as a real check. The matrix is `os: [ubuntu-latest, windows-latest]` on both smoke and extension jobs.
- Smoke-harness flakes surface as merge blockers — that's the point, but it means harness flakiness has to be fixed at the source (helper functions, platform-conditional timeouts, deterministic ports) rather than tolerated. The #538 multiplier is the template.
- Future Windows-specific test additions should default to `expect.toPass({ timeout: timeoutMs * WIN_TIMEOUT_MULTIPLIER })` rather than bare millisecond literals.
- Originating PRs: #532 (introduction), #537 (flip), #538 (timeout tune).
