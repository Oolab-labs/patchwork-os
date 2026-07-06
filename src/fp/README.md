# src/fp — Automation DSL

This subsystem compiles event-driven automation hooks (`onFileSave`,
`onGitCommit`, `onTestRun`, etc.) into a small algebraic DSL and runs them
through a single, side-effect-isolated interpreter. It's what backs
`AutomationHooks`: policy JSON in, gated/deduped/rate-limited Claude tasks
(and optional webhooks) out. See CLAUDE.md's "Automation Policy" /
"Automation DSL" sections for the full ~20-entry hook-type catalog and
activation flags — this README only covers the DSL machinery itself.

## The 5 files that matter and why

- **`automationProgram.ts`** — the ADT. Defines `HookType`, `PromptSourceNode`,
  `WhenCondition`, and the seven `AutomationProgram` node tags (`Hook`,
  `Sequence`, `Parallel`, `WithCooldown`, `WithDedup`, `WithRateLimit`,
  `WithRetry`), plus their smart constructors. This is the shape everything
  else operates on.
- **`policyParser.ts`** — `parsePolicy`. Pure function that turns a validated
  `AutomationPolicy` JSON object into `AutomationProgram[]`. No I/O, no
  `Date.now()`. This is where a new hook type gets its parser case.
- **`automationInterpreter.ts`** — `executeAutomationPolicy`, the single
  recursive interpreter for the whole DSL. Walks the program tree, applies
  cooldown/dedup/rate-limit/retry semantics, and calls out to a `Backend` for
  every side effect (enqueue task, fire webhook, fire recipe).
- **`interpreterContext.ts`** — the `Backend` interface plus its two
  implementations: `VsCodeBackend` (production — talks to the real
  orchestrator, DNS, SSRF guard) and `TestBackend` (a plain collector with
  `reset()`, used by tests instead of mocking VS Code).
- **`automationState.ts`** — `AutomationState`, the single immutable value
  `AutomationHooks` holds (cooldown timestamps, active tasks, dedup window,
  pending retries, etc.) plus the pure transition functions that produce new
  state, including `mergeAutomationStates` (max-timestamp-per-key merge used
  after `Parallel` branches).

## Invariants you must not break

- **State transitions are pure.** Never mutate an `AutomationState` in place.
  Every change goes through a function in `automationState.ts` that takes the
  old state and returns a new one.
- **New hooks require three coordinated edits**: extend the `HookType` union
  in `automationProgram.ts`, add a parsing case in `policyParser.ts`, and wire
  the hook to `_runInterpreter(hookType, eventData)` in `AutomationHooks`.
  Missing any one of these leaves the hook unreachable or unparseable.
- **All side effects go through `Backend`.** The interpreter must never call
  a VS Code API, spawn a process, or make a network request directly — it
  only calls methods on the `Backend` it's given. This is what lets
  `TestBackend` intercept every effect in tests.
- Full hook-type catalog, activation flags, and webhook fan-out semantics are
  documented in `CLAUDE.md` ("Automation Policy" section) and
  [docs/adr/0009-automation-webhook-fanout.md](../../docs/adr/0009-automation-webhook-fanout.md)
  — don't re-derive them here.

## How to test it

Tests live in `src/fp/__tests__/` (vitest), one file per module
(`automationInterpreter.test.ts`, `policyParser.test.ts`,
`automationState.test.ts`, `properties.test.ts` for property-based checks,
etc.). Run with:

```bash
npm test -- src/fp
```

Interpreter tests construct an `InterpreterContext` with `backend: new
TestBackend()` and call `executeAutomationPolicy`. Because `TestBackend` is a
collector, assertions read its recorded calls (enqueued tasks, fired
webhooks, fired recipes) directly instead of mocking VS Code or the
orchestrator — call `backend.reset()` between cases in the same test to
clear the collector without re-constructing it.
