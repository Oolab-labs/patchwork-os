# Testing — how to write a test that belongs here

The runner is vitest everywhere: the bridge, the dashboard, the extension and
the push relay each run `vitest run` from their own directory. The bridge's
`vitest.config.ts` includes `src/**/*.test.ts` and `scripts/**/*.test.mjs`
and holds the coverage thresholds.

## Where tests live

| Code under test | Tests |
|---|---|
| `src/*.ts` (top level) | `src/__tests__/` |
| `src/<module>/` | `src/<module>/__tests__/` (e.g. `src/recipes/__tests__/`, `src/workers/__tests__/`) |
| `src/tools/*.ts` | `src/tools/__tests__/` — every new tool needs one |
| `dashboard/src/**` | `dashboard/src/**/__tests__/` next to the code (`app/`, `components/`, `hooks/`, `lib/`) |
| `vscode-extension/src/handlers/*.ts` | `vscode-extension/src/__tests__/handlers/` — every new handler needs one |
| `services/push-relay/src/` | its own `__tests__/` |

Run one file without the bridge wrapper (see
[development.md](development.md) for why `npm test` is not plain vitest):

```bash
npm run test:raw -- src/workers/__tests__/previewActions.test.ts
```

## The bug-fix protocol

When a bug is reported, do not start by fixing it.

1. Write a test that reproduces it. **The test must fail.** Run it and watch
   it fail; a test you have only seen pass has proven nothing about the bug.
2. Fix the bug. Confirm the test passes.
3. Only then call it fixed.

The order matters because of how often the reported problem is not the actual
problem here. A failing test pins what you believe is wrong; if the fix does
not make it pass, you learned that before shipping.

## Fixture hygiene

`scripts/audit-test-fixtures.mjs` runs in CI before the build and checks
three things: no hardcoded `/tmp/` paths (use `os.tmpdir()`), no
`process.env.X = ...` without a paired restore in `afterEach` / `afterAll` or
`vi.stubEnv`, and no `vi.spyOn` without `vi.restoreAllMocks()` or
`vi.resetAllMocks()` in a cleanup block. Its allowlist is a ratchet; you may
not add to it.

Two rules the gate cannot check:

- **Synthetic names only.** No real organisation, person, domain, email,
  channel id, account id or recipe name from a real install. Governance and
  privacy fixtures pull real names in by gravity — a real vendor is the
  obvious example to reach for — and a privacy engine that leaks in its own
  test data is the sharpest possible own goal. Use `example.test`, `acct-0001`,
  `noisy-recipe`. The full rule is in [privacy-rules.md](privacy-rules.md).
- **Set `PATCHWORK_HOME` in any test that can reach a disconnect, clear or
  delete path.** A connector test once unlinked a real credential from a
  developer's machine because one `describe` ran with the variable unset.
  `scripts/audit-connector-test-isolation.mjs` ratchets the known hazards.

## Guard tests pin deliberate behaviour

Some behaviour in this repo looks like a defect and is not. The canonical
example is in `src/recipes/__tests__/flatCompoundSteps.test.ts`: a `describe`
block whose name says the paths inside it must **not** change, pinning the
rule that a recipe step whose tool id is not registered is skipped silently
and the run finishes `done`. It reads as fail-open; it is forward
compatibility for plugins that are not loaded, and `recipe doctor` reports the
unresolved tool where an operator will look. Two separate attempts to "fix" it
were caught by that block.

The pattern: when a decision was made deliberately and the code could be
"corrected" by someone who does not know that, write a test whose name states
the decision and whose failure message points at the reason. Other examples
in the tree assert that a shipped worker never owns the catch-all `other`
domain, that the recipe-facing GitHub tool surface has no mutation beyond
`create_issue`, that observation runs before enforcement at a specific call
site, and that a malformed orchestrator classification fails open. A guard
test is documentation that fails when ignored.

## Mutation-check your test

Before trusting a green test, ask: **would a broken version have failed
this?** Concretely, break the thing on purpose and run the test again. Several
real cases from this repo where the first version of the test could not fail:

- A source-order guard compared two function *declarations*, which never
  move, instead of the two *calls* whose order it was meant to pin. It passed
  against a deliberately swapped call site.
- A test asserted a fixture recipe's name was absent from a snapshot, but the
  fixture name was ordinary enough that a faithful hardcode of the wrong value
  also passed. Parameterise the seam, then mutate it with a correct-looking
  copy.
- A test of a count compared rows, not kinds, and would have reported requests
  doubled under a schema it was supposed to tolerate.
- A spawn-wiring test called the function directly with mocked dependencies.
  The logic was proven; the production call site was unreachable for weeks.
  Hand-injected dependencies prove logic, never wiring.

If you cannot make the test fail by breaking the code, the test is not
testing that code.

## Windows is a blocking CI cell

All bridge tests run on `windows-latest` and the cell is required
([ADR-0012](../adr/0012-windows-ci-blocking.md)).
[docs/windows.md](../windows.md#common-patterns-when-contributing) lists the
patterns that keep it green. Two incidents worth knowing before you debug a
Windows-only failure:

- **A test process that dies with no assertion and no vitest summary is an
  abort, not a failure.** The historical cause: libuv's file-watcher asserts
  that a reported filename starts with the directory it was handed, and it
  reports the *canonical* path. Handing it an 8.3 short path (what
  `fs.mkdtempSync(os.tmpdir())` returns on the CI runner) aborted the stdio
  shim; an abort is not throwable, so no `try/catch` saw it. Fixed with
  `fs.realpathSync.native` before watching. Node 24 asserts; Node 22 did not,
  which is why the cell looked like a vitest bug for weeks.
- **The coverage step is the tight one, not the test step.** The
  `sqliteRunStoreSpecifics` suite is heavy-tailed on Windows — a median of
  tens of seconds and a worst case of minutes — so a ceiling that
  accommodates the tail lets three retries consume the whole step budget.
  Before raising a `timeout-minutes`, check which step actually died.

`scripts/vitest-progress-reporter.mjs` writes module start/end markers
synchronously and CI uploads them with `if: always()`. A missing `run-end`
means the run was killed; a `module-start` with no `module-end` names what was
in flight. Every other reporter writes at the end, which is the moment a
killed run never reaches.

## Connection and reconnect changes

Any change to the connection path tests the circuit breaker and reconnect
behaviour, including the generation guard
([ADR-0002](../adr/0002-generation-guards-on-reconnect.md)) — a stale callback
from a previous socket must not touch new state. Existing suites under
`vscode-extension/src/__tests__/` (`connection*.test.ts`) show the shape.

## Typecheck your tests

Vitest does not typecheck. `npm run typecheck:tests:core` does, with
`noUnusedLocals`, and it is a CI step. A test that is green under vitest and
red under the ratchet is a red build. Details in
[development.md](development.md).
